import type { FastifyBaseLogger } from "fastify";
import { ERP_TIMEOUT_MS } from "../config.js";
import { ErpTimeoutError, FakeErp } from "../integrations/fake-erp.js";
import { prisma } from "../lib/prisma.js";
import {
  erpRequestDurationSeconds,
  erpRequestsTotal,
  stockCompensationsTotal,
  workerJobsTotal,
  workerProcessingDurationSeconds,
  workerRetriesTotal,
} from "../observability/metrics.js";
import { invalidateProductsCache } from "./product-service.js";

export type ProcessOrderDeps = {
  erp: FakeErp;
  logger: FastifyBaseLogger;
  isLastAttempt: boolean;
  timeoutMs?: number;
  correlationId?: string;
  outboxEventId?: string;
  attempt?: number;
};

function durationMsSince(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function durationSecondsSince(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }
  return undefined;
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ErpTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function failOrderAndReleaseStock(
  orderId: string,
  logger: FastifyBaseLogger,
  correlationId?: string,
): Promise<boolean> {
  const released = await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: {
        id: orderId,
        stockReleasedAt: null,
        status: { not: "COMPLETED" },
      },
      data: {
        status: "FAILED",
        stockReleasedAt: new Date(),
      },
    });

    if (claimed.count !== 1) {
      return false;
    }

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });

    for (const item of order.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } },
      });
    }

    return true;
  });

  if (released) {
    stockCompensationsTotal.inc();
    logger.info(
      { event: "stock_compensation_completed", orderId, correlationId },
      "Local stock restored after definitive ERP failure",
    );
    await invalidateProductsCache(logger);
  } else {
    logger.info(
      { event: "stock_compensation_skipped", orderId, correlationId },
      "Stock compensation skipped",
    );
  }

  return released;
}

async function callErp(
  orderId: string,
  deps: ProcessOrderDeps,
  timeoutMs: number,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  deps.logger.info(
    {
      event: "erp_request_started",
      orderId,
      correlationId: deps.correlationId,
      attempt: deps.attempt,
    },
    "ERP request started",
  );

  try {
    await withTimeout(
      (signal) => deps.erp.processOrder(orderId, signal),
      timeoutMs,
    );
    const durationSeconds = durationSecondsSince(startedAt);
    erpRequestsTotal.inc({ result: "success" });
    erpRequestDurationSeconds.observe({ result: "success" }, durationSeconds);
    deps.logger.info(
      {
        event: "erp_request_completed",
        orderId,
        correlationId: deps.correlationId,
        durationMs: durationSeconds * 1000,
        attempt: deps.attempt,
      },
      "ERP request completed",
    );
  } catch (error) {
    const durationSeconds = durationSecondsSince(startedAt);
    const timedOut = error instanceof ErpTimeoutError;
    const result = timedOut ? "timeout" : "error";
    erpRequestsTotal.inc({ result });
    erpRequestDurationSeconds.observe({ result }, durationSeconds);
    deps.logger.error(
      {
        event: timedOut ? "erp_timeout" : "erp_error",
        orderId,
        correlationId: deps.correlationId,
        durationMs: durationSeconds * 1000,
        attempt: deps.attempt,
        errorCode: errorCode(error),
        err: error,
      },
      timedOut ? "ERP timed out" : "ERP call failed",
    );
    throw error;
  }
}

export async function processOrder(
  orderId: string,
  deps: ProcessOrderDeps,
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? ERP_TIMEOUT_MS;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  if (order.status === "COMPLETED" || order.status === "FAILED") {
    deps.logger.info(
      {
        event: "order_processing_completed",
        orderId,
        correlationId: deps.correlationId,
        status: order.status,
      },
      "Skipping already finished order",
    );
    return;
  }

  if (order.status === "PENDING" || order.status === "PROCESSING") {
    await prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "PROCESSING" },
    });
  }

  const processingStartedAt = process.hrtime.bigint();
  deps.logger.info(
    {
      event: "order_processing_started",
      orderId,
      correlationId: deps.correlationId,
      outboxEventId: deps.outboxEventId,
      attempt: deps.attempt,
    },
    "Worker started order",
  );

  try {
    await callErp(orderId, deps, timeoutMs);
    const completed = await prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "COMPLETED" },
    });
    if (completed.count !== 1) {
      return;
    }
    workerJobsTotal.inc({ result: "completed" });
    workerProcessingDurationSeconds.observe(
      { result: "completed" },
      durationSecondsSince(processingStartedAt),
    );
    deps.logger.info(
      {
        event: "order_processing_completed",
        orderId,
        correlationId: deps.correlationId,
        durationMs: durationMsSince(processingStartedAt),
        attempt: deps.attempt,
      },
      "Worker finished order",
    );
  } catch (error) {
    if (deps.isLastAttempt) {
      await failOrderAndReleaseStock(orderId, deps.logger, deps.correlationId);
      workerJobsTotal.inc({ result: "failed" });
      workerProcessingDurationSeconds.observe(
        { result: "failed" },
        durationSecondsSince(processingStartedAt),
      );
      deps.logger.error(
        {
          event: "order_processing_failed",
          orderId,
          correlationId: deps.correlationId,
          outboxEventId: deps.outboxEventId,
          durationMs: durationMsSince(processingStartedAt),
          attempt: deps.attempt,
          errorCode: errorCode(error),
          err: error,
        },
        "Worker exhausted retries",
      );
    } else {
      workerRetriesTotal.inc();
      deps.logger.error(
        {
          event: "order_processing_retry",
          orderId,
          correlationId: deps.correlationId,
          outboxEventId: deps.outboxEventId,
          attempt: deps.attempt,
          errorCode: errorCode(error),
          err: error,
        },
        "Worker will retry order processing",
      );
    }

    throw error;
  }
}
