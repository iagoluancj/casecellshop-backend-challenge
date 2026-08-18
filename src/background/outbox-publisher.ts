import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import {
  ORDER_JOB_ATTEMPTS,
  ORDER_JOB_BACKOFF_MS,
  ORDER_JOB_NAME,
  OUTBOX_POLL_INTERVAL_MS,
} from "../config.js";
import type {
  ProcessOrderJobData,
  ProcessOrderOutboxPayload,
} from "../jobs/order-job.js";
import { prisma } from "../lib/prisma.js";
import {
  outboxPublishedTotal,
  outboxPublishFailuresTotal,
} from "../observability/metrics.js";

function readOutboxPayload(payload: unknown): ProcessOrderOutboxPayload {
  const data = payload as { orderId?: string; correlationId?: string };
  return {
    orderId: typeof data.orderId === "string" ? data.orderId : "",
    correlationId:
      typeof data.correlationId === "string" && data.correlationId.length > 0
        ? data.correlationId
        : randomUUID(),
  };
}

export async function publishPendingOutbox(
  queue: Queue,
  logger: FastifyBaseLogger,
): Promise<void> {
  const events = await prisma.outboxEvent.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  for (const event of events) {
    const payload = readOutboxPayload(event.payload);
    const orderId = payload.orderId || event.orderId;
    const correlationId = payload.correlationId;

    logger.info(
      {
        event: "outbox_publish_started",
        outboxEventId: event.id,
        orderId,
        correlationId,
      },
      "Pending outbox event found",
    );

    try {
      const job: ProcessOrderJobData = {
        orderId,
        outboxEventId: event.id,
        correlationId,
      };

      await queue.add(ORDER_JOB_NAME, job, {
        jobId: event.id,
        attempts: ORDER_JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: ORDER_JOB_BACKOFF_MS,
        },
        removeOnComplete: 100,
        removeOnFail: 100,
      });

      await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: "PENDING" },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
        },
      });

      outboxPublishedTotal.inc();
      logger.info(
        {
          event: "outbox_published",
          outboxEventId: event.id,
          orderId,
          correlationId,
        },
        "Outbox event published to queue",
      );
    } catch (error) {
      const alreadyQueued =
        error instanceof Error &&
        /already (exists|exist)/i.test(error.message);

      if (alreadyQueued) {
        await prisma.outboxEvent.updateMany({
          where: { id: event.id, status: "PENDING" },
          data: {
            status: "PUBLISHED",
            publishedAt: new Date(),
          },
        });
        outboxPublishedTotal.inc();
        logger.info(
          {
            event: "outbox_published",
            outboxEventId: event.id,
            orderId,
            correlationId,
          },
          "Outbox event already in queue, marked published",
        );
        continue;
      }

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 } },
      });

      outboxPublishFailuresTotal.inc();
      logger.error(
        {
          event: "outbox_publish_failed",
          outboxEventId: event.id,
          orderId,
          correlationId,
          errorCode: error instanceof Error ? error.name : undefined,
          err: error,
        },
        "Failed to publish outbox event",
      );
    }
  }
}

export function startOutboxPublisher(
  queue: Queue,
  logger: FastifyBaseLogger,
  intervalMs = OUTBOX_POLL_INTERVAL_MS,
) {
  let inFlight = false;

  const tick = () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void publishPendingOutbox(queue, logger).finally(() => {
      inFlight = false;
    });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    async stop() {
      clearInterval(timer);
      while (inFlight) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
