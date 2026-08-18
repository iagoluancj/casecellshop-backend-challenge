import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import {
  ORDER_JOB_ATTEMPTS,
  ORDER_JOB_BACKOFF_MS,
  ORDER_JOB_NAME,
  OUTBOX_POLL_INTERVAL_MS,
} from "../config.js";
import { prisma } from "../lib/prisma.js";

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
    const payload = event.payload as { orderId?: string };
    const orderId = payload.orderId ?? event.orderId;

    logger.info(
      { event: "outbox_found", outboxEventId: event.id, orderId },
      "Pending outbox event found",
    );

    try {
      await queue.add(
        ORDER_JOB_NAME,
        { orderId, outboxEventId: event.id },
        {
          jobId: event.id,
          attempts: ORDER_JOB_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: ORDER_JOB_BACKOFF_MS,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );

      await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: "PENDING" },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
        },
      });

      logger.info(
        { event: "outbox_published", outboxEventId: event.id, orderId },
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
        logger.info(
          { event: "outbox_published", outboxEventId: event.id, orderId },
          "Outbox event already in queue, marked published",
        );
        continue;
      }

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 } },
      });

      logger.error(
        {
          event: "outbox_publication_failed",
          outboxEventId: event.id,
          orderId,
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
    },
  };
}
