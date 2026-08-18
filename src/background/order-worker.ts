import type { FastifyBaseLogger } from "fastify";
import { Worker, type Job } from "bullmq";
import {
  ERP_TIMEOUT_MS,
  ORDER_JOB_ATTEMPTS,
  ORDER_QUEUE_NAME,
} from "../config.js";
import {
  createDefaultFakeErp,
  type FakeErp,
} from "../integrations/fake-erp.js";
import {
  createBullmqConnection,
  type BullmqPrefixOptions,
} from "../lib/bullmq.js";
import {
  failOrderAndReleaseStock,
  processOrder,
} from "../services/process-order-service.js";

type OrderJobData = {
  orderId: string;
  outboxEventId?: string;
};

function maxAttempts(job: Job<OrderJobData>): number {
  return job.opts.attempts ?? ORDER_JOB_ATTEMPTS;
}

function isLastAttempt(job: Job<OrderJobData>): boolean {
  const attempts = maxAttempts(job);
  // BullMQ 6: attemptsStarted increments when the job becomes active;
  // attemptsMade is previous failures. Using both avoids a wrong FAILED/retry.
  const currentAttempt = Math.max(job.attemptsStarted, job.attemptsMade + 1);
  return currentAttempt >= attempts;
}

export function startOrderWorker(
  logger: FastifyBaseLogger,
  erp: FakeErp = createDefaultFakeErp(),
  options: BullmqPrefixOptions = {},
) {
  const connection = createBullmqConnection();

  const worker = new Worker<OrderJobData>(
    ORDER_QUEUE_NAME,
    async (job) => {
      await processOrder(job.data.orderId, {
        erp,
        logger,
        isLastAttempt: isLastAttempt(job),
        timeoutMs: ERP_TIMEOUT_MS,
      });
    },
    {
      connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );

  worker.on("failed", (job, error) => {
    logger.error(
      {
        event: "worker_failure",
        orderId: job?.data.orderId,
        outboxEventId: job?.data.outboxEventId,
        attemptsMade: job?.attemptsMade,
        err: error,
      },
      "Order worker job failed",
    );

    if (!job) {
      return;
    }

    void job.getState().then(async (state) => {
      // Intermediate retries go back to delayed/waiting. Only the last
      // failure stays in the failed set — that's when we mark Order FAILED.
      if (state === "failed") {
        await failOrderAndReleaseStock(job.data.orderId, logger);
      }
    });
  });

  return {
    worker,
    connection,
    async close() {
      await worker.close();
      await connection.quit();
    },
  };
}
