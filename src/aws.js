// aws.js - creates the three AWS SDK v3 clients.
// The ONLY difference from real AWS is "endpoint": it points the SDK at Moto.
const { SQSClient } = require("@aws-sdk/client-sqs");
const { SNSClient } = require("@aws-sdk/client-sns");
const { EventBridgeClient } = require("@aws-sdk/client-eventbridge");
const config = require("./config");

const clientSettings = {
  region: config.region,
  endpoint: config.endpoint,
  // Dummy credentials: the SDK requires some, Moto does not check them.
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

// Build a queue URL ourselves instead of using the one AWS returns.
// LocalStack returns URLs like http://sqs.us-east-1.localhost.localstack.cloud:4566/...
// which do not resolve correctly inside Docker containers. This path-style URL always works.
function queueUrl(name) {
  return `${config.endpoint}/${config.accountId}/${name}`;
}

module.exports = {
  queueUrl,
  sqs: new SQSClient(clientSettings),
  sns: new SNSClient(clientSettings),
  eventBridge: new EventBridgeClient(clientSettings),
};
