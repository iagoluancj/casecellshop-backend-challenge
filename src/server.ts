import "dotenv/config";
import { buildApp } from "./app.js";
import { startOrderWorker } from "./background/order-worker.js";
import { startOutboxPublisher } from "./background/outbox-publisher.js";
import { createBullmqConnection, createOrderQueue } from "./lib/bullmq.js";
import { bindQueueMetrics } from "./observability/metrics.js";

const port = Number(process.env.PORT) || 3000;

const app = await buildApp();
const queueConnection = createBullmqConnection();
const orderQueue = createOrderQueue(queueConnection);
bindQueueMetrics(orderQueue);
const publisher = startOutboxPublisher(orderQueue, app.log);
const worker = startOrderWorker(app.log);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  app.log.info({ event: "shutdown", signal }, "Shutting down");

  try {
    await worker.close();
    bindQueueMetrics(null);
    await orderQueue.close();
    await queueConnection.quit();
    await publisher.stop();
    await app.close();
  } catch (error) {
    app.log.error({ event: "shutdown_error", err: error }, "Shutdown failed");
    process.exit(1);
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  await shutdown("listen_error");
}
