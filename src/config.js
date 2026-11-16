// config.js - every setting lives here, read from environment variables.
// Defaults let you also run the code directly on Windows (outside Docker),
// where the emulator is at http://localhost:4566.

module.exports = {
  endpoint: process.env.AWS_ENDPOINT_URL || "http://localhost:4566",
  region: process.env.AWS_REGION || "us-east-1",
  port: Number(process.env.PORT) || 3000,
  // LocalStack uses account 000000000000. (Only change this if you swap emulators.)
  accountId: process.env.AWS_ACCOUNT_ID || "000000000000",

  // Names of the AWS resources we create
  ordersQueueName: "orders-queue",
  ordersDlqName: "orders-dlq",               // failed orders end up here
  notificationsQueueName: "notifications-queue",
  topicName: "OrderNotifications",
  eventBusName: "orders-bus",
  ruleName: "order-completed-rule",

  // The event "label" the worker publishes and the rule matches on
  eventSource: "mini-order-system.worker",
  eventDetailType: "OrderCompleted",
};
