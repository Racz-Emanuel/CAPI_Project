// worker.js - background process. Loop forever:
//   receive order from SQS -> "process" it -> publish OrderCompleted to EventBridge -> delete message.
const { ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { PutEventsCommand } = require("@aws-sdk/client-eventbridge");
const { sqs, eventBridge, queueUrl } = require("./aws");
const config = require("./config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processOrder(order, receiveCount) {
  console.log(`[worker] Processing order ${order.orderId} (${order.quantity} x ${order.product} for ${order.customerName}), attempt #${receiveCount}`);

  // DEMO: an order for product "FAIL" always crashes, to show retries + dead-letter queue.
  if (order.product === "FAIL") throw new Error("Simulated processing failure");

  await sleep(2000); // pretend to charge the card, pack the box, etc.
  console.log(`[worker] Order ${order.orderId} processed. Publishing OrderCompleted event...`);

  const result = await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: config.eventBusName,
      Source: config.eventSource,
      DetailType: config.eventDetailType,
      Detail: JSON.stringify({
        orderId: order.orderId,
        customerName: order.customerName,
        product: order.product,
        quantity: order.quantity,
        status: "COMPLETED",
        timestamp: new Date().toISOString(),
      }),
    }],
  }));

  // PutEvents can "succeed" as an HTTP call while individual events failed.
  if (result.FailedEntryCount > 0) {
    throw new Error("EventBridge rejected the event: " + JSON.stringify(result.Entries));
  }
  console.log(`[worker] OrderCompleted event published for ${order.orderId}`);
}

async function main() {
  const ordersUrl = queueUrl(config.ordersQueueName);
  console.log("[worker] Started. Polling", ordersUrl);

  while (true) {
    try {
      // Long polling: wait up to 5 s for a message instead of hammering the server.
      const res = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: ordersUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
        AttributeNames: ["ApproximateReceiveCount"],
      }));

      for (const message of res.Messages || []) {
        try {
          const order = JSON.parse(message.Body);
          await processOrder(order, message.Attributes.ApproximateReceiveCount);
          // Delete ONLY after success.
          await sqs.send(new DeleteMessageCommand({ QueueUrl: ordersUrl, ReceiptHandle: message.ReceiptHandle }));
          console.log(`[worker] Message deleted from queue for order ${order.orderId}`);
        } catch (err) {
          // No delete: the message reappears after the visibility timeout and is retried.
          console.error("[worker] Processing FAILED, message left in queue for retry:", err.message);
        }
      }
    } catch (err) {
      console.error("[worker] Cannot reach SQS, retrying in 3s:", err.message);
      await sleep(3000);
    }
  }
}

main();
