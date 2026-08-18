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
import type { ProcessOrderJobData } from "../jobs/order-job.js";
import {
  createBullmqConnection,
  type BullmqPrefixOptions,
} from "../lib/bullmq.js";
import {
  failOrderAndReleaseStock,
  processOrder,
} from "../services/process-order-service.js";

function maxAttempts(job: Job<ProcessOrderJobData>): number {
  return job.opts.attempts ?? ORDER_JOB_ATTEMPTS;
}

function isLastAttempt(job: Job<ProcessOrderJobData>): boolean {
  const attempts = maxAttempts(job);
  const currentAttempt = Math.max(job.attemptsStarted, job.attemptsMade + 1);
  return currentAttempt >= attempts;
}

export function startOrderWorker(
  logger: FastifyBaseLogger,
  erp: FakeErp = createDefaultFakeErp(),
  options: BullmqPrefixOptions = {},
) {
  const connection = createBullmqConnection();

  const worker = new Worker<ProcessOrderJobData>(
    ORDER_QUEUE_NAME,
    async (job) => {
      const correlationId = job.data.correlationId;
      const jobLogger = logger.child({
        correlationId,
        orderId: job.data.orderId,
        outboxEventId: job.data.outboxEventId,
      });

      await processOrder(job.data.orderId, {
        erp,
        logger: jobLogger,
        isLastAttempt: isLastAttempt(job),
        timeoutMs: ERP_TIMEOUT_MS,
        correlationId,
        outboxEventId: job.data.outboxEventId,
        attempt: job.attemptsStarted,
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
        event: "order_processing_failed",
        orderId: job?.data.orderId,
        outboxEventId: job?.data.outboxEventId,
        correlationId: job?.data.correlationId,
        attempt: job?.attemptsMade,
        errorCode: error.name,
        err: error,
      },
      "Order worker job failed",
    );

    if (!job) {
      return;
    }

    void job
      .getState()
      .then(async (state) => {
        if (state !== "failed") {
          return;
        }

        await failOrderAndReleaseStock(
          job.data.orderId,
          logger.child({
            correlationId: job.data.correlationId,
            orderId: job.data.orderId,
          }),
          job.data.correlationId,
        );
      })
      .catch((compensationError: unknown) => {
        logger.error(
          {
            event: "stock_compensation_failed",
            orderId: job.data.orderId,
            correlationId: job.data.correlationId,
            err: compensationError,
          },
          "Stock compensation after job failure threw",
        );
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
