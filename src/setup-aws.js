// setup-aws.js - creates every AWS resource. Safe to run many times.
// Run order matters: queues -> topic -> subscription -> bus -> rule -> target.
const {
  CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand,
} = require("@aws-sdk/client-sqs");
const { CreateTopicCommand, SubscribeCommand } = require("@aws-sdk/client-sns");
const {
  CreateEventBusCommand, PutRuleCommand, PutTargetsCommand,
} = require("@aws-sdk/client-eventbridge");
const { sqs, sns, eventBridge, queueUrl } = require("./aws");
const config = require("./config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CreateQueue returns the existing queue if it already exists (same settings),
// so it is naturally repeatable.
async function createQueue(name, attributes = {}) {
  await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  const url = queueUrl(name);
  const attrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: url, AttributeNames: ["QueueArn"],
  }));
  return { url, arn: attrs.Attributes.QueueArn };
}

// The emulator may still be booting when we start, so retry a few times.
async function waitForEmulator() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await sqs.send(new CreateQueueCommand({ QueueName: config.ordersDlqName }));
      console.log("[setup] Emulator is reachable at " + config.endpoint);
      return;
    } catch (err) {
      console.log(`[setup] Emulator not ready (attempt ${attempt}/30): ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error("Could not connect to the AWS emulator at " + config.endpoint);
}

async function main() {
  await waitForEmulator();

  // 1) SQS queues
  const dlq = await createQueue(config.ordersDlqName);
  const orders = await createQueue(config.ordersQueueName, {
    VisibilityTimeout: "10", // a failed message becomes visible again after 10 s
    // After 3 failed receives, SQS moves the message to the dead-letter queue.
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: "3" }),
  });
  const notifications = await createQueue(config.notificationsQueueName);
  console.log("[setup] SQS queues ready:", orders.url, notifications.url);

  // 2) SNS topic (CreateTopic is idempotent)
  const topic = await sns.send(new CreateTopicCommand({ Name: config.topicName }));
  console.log("[setup] SNS topic ready:", topic.TopicArn);

  // 3) Allow the topic to write into the notifications queue (real AWS needs this)
  const policy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "sns.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: notifications.arn,
      Condition: { ArnEquals: { "aws:SourceArn": topic.TopicArn } },
    }],
  };
  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: notifications.url, Attributes: { Policy: JSON.stringify(policy) },
  }));

  // 4) Subscribe the notifications queue to the topic (idempotent)
  await sns.send(new SubscribeCommand({
    TopicArn: topic.TopicArn, Protocol: "sqs", Endpoint: notifications.arn,
  }));
  console.log("[setup] SNS -> notifications queue subscription ready");

  // 5) EventBridge custom bus. Real AWS errors if it exists, so we tolerate that.
  try {
    await eventBridge.send(new CreateEventBusCommand({ Name: config.eventBusName }));
  } catch (err) {
    if (err.name !== "ResourceAlreadyExistsException") throw err;
  }
  console.log("[setup] EventBridge bus ready:", config.eventBusName);

  // 6) Rule: match only our OrderCompleted events (PutRule is idempotent)
  await eventBridge.send(new PutRuleCommand({
    Name: config.ruleName,
    EventBusName: config.eventBusName,
    State: "ENABLED",
    EventPattern: JSON.stringify({
      source: [config.eventSource],
      "detail-type": [config.eventDetailType],
    }),
  }));

  // 7) Target: send matching events to the SNS topic (PutTargets is idempotent)
  const targetRes = await eventBridge.send(new PutTargetsCommand({
    Rule: config.ruleName,
    EventBusName: config.eventBusName,
    Targets: [{ Id: "sns-target", Arn: topic.TopicArn }],
  }));
  if (targetRes.FailedEntryCount > 0) {
    throw new Error("PutTargets failed: " + JSON.stringify(targetRes.FailedEntries));
  }
  console.log("[setup] EventBridge rule + SNS target ready");
  console.log("[setup] DONE - all resources exist.");
}

main().catch((err) => {
  console.error("[setup] FAILED:", err);
  process.exit(1);
});
