// api.js - the REST API. It only ACCEPTS orders and puts them on a queue.
// It does not process them; the worker does that later (asynchronously).
const express = require("express");
const crypto = require("crypto");
const { SendMessageCommand, ReceiveMessageCommand } = require("@aws-sdk/client-sqs");
const { sqs, queueUrl } = require("./aws");
const config = require("./config");

const app = express();
app.use(express.json());

// Serve the simple web page in the "public" folder at http://localhost:3000/
app.use(express.static(require("path").join(__dirname, "..", "public")));

// Returns a list of error strings (empty list = valid).
function validateOrder(body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["Body must be a JSON object"];
  if (typeof body.customerName !== "string" || body.customerName.trim() === "")
    errors.push("customerName must be a non-empty string");
  if (typeof body.product !== "string" || body.product.trim() === "")
    errors.push("product must be a non-empty string");
  if (!Number.isInteger(body.quantity) || body.quantity < 1)
    errors.push("quantity must be an integer >= 1");
  return errors;
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

// POST /orders -> validate, create ID, send to SQS, answer immediately.
app.post("/orders", async (req, res) => {
  const errors = validateOrder(req.body);
  if (errors.length > 0) return res.status(400).json({ error: "Invalid order", details: errors });

  const order = {
    orderId: crypto.randomUUID(),
    customerName: req.body.customerName.trim(),
    product: req.body.product.trim(),
    quantity: req.body.quantity,
    createdAt: new Date().toISOString(),
  };

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl(config.ordersQueueName),
      MessageBody: JSON.stringify(order),
    }));
    console.log(`[api] Order ${order.orderId} sent to SQS`);
    res.status(202).json({ orderId: order.orderId, message: "Order accepted and queued for processing" });
  } catch (err) {
    console.error("[api] Could not send order to SQS:", err.message);
    res.status(503).json({ error: "Could not queue the order. Is the AWS emulator running?" });
  }
});

// GET /notifications -> PEEK at the notifications queue (to prove SNS delivered).
// VisibilityTimeout 0 means messages are not hidden, so you can call it repeatedly.
app.get("/notifications", async (req, res) => {
  try {
    const result = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl(config.notificationsQueueName),
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 0,
    }));
    const notifications = (result.Messages || []).map((m) => {
      const snsEnvelope = JSON.parse(m.Body);   // SNS wraps what it delivers in an envelope...
      let event = snsEnvelope.Message;          // ...and the EventBridge event is inside "Message"
      try { event = JSON.parse(event); } catch (e) { /* keep as plain text */ }
      return { topicArn: snsEnvelope.TopicArn, event };
    });
    res.json({ count: notifications.length, notifications });
  } catch (err) {
    console.error("[api] Could not read notifications:", err.message);
    res.status(503).json({ error: "Could not read notifications queue" });
  }
});

// GET /failed-orders -> peek at the dead-letter queue.
app.get("/failed-orders", async (req, res) => {
  try {
    const result = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl(config.ordersDlqName),
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 0,
    }));
    res.json({ count: (result.Messages || []).length, orders: (result.Messages || []).map((m) => JSON.parse(m.Body)) });
  } catch (err) {
    res.status(503).json({ error: "Could not read dead-letter queue" });
  }
});

// Catch JSON syntax errors and anything unexpected.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Body is not valid JSON" });
  console.error("[api] Unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => console.log(`[api] Listening on port ${config.port}`));
