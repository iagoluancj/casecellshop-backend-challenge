import type { FastifyBaseLogger } from "fastify";
import { ERP_TIMEOUT_MS } from "../config.js";
import { ErpTimeoutError, FakeErp } from "../integrations/fake-erp.js";
import { prisma } from "../lib/prisma.js";
import { invalidateProductsCache } from "./product-service.js";

export type ProcessOrderDeps = {
  erp: FakeErp;
  logger: FastifyBaseLogger;
  isLastAttempt: boolean;
  timeoutMs?: number;
};

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
    logger.info({ event: "order_failed", orderId }, "Order marked FAILED");
    logger.info(
      { event: "stock_compensation_executed", orderId },
      "Local stock restored after definitive ERP failure",
    );
    await invalidateProductsCache(logger);
  }

  return released;
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
      { event: "worker_completed", orderId, status: order.status },
      "Skipping already finished order",
    );
    return;
  }

  if (order.status === "PENDING") {
    await prisma.order.updateMany({
      where: { id: orderId, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
  }

  deps.logger.info({ event: "worker_started", orderId }, "Worker started order");

  try {
    await withTimeout(
      (signal) => deps.erp.processOrder(orderId, signal),
      timeoutMs,
    );
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "COMPLETED" },
    });
    deps.logger.info(
      { event: "order_completed", orderId },
      "Order completed after ERP success",
    );
    deps.logger.info(
      { event: "worker_completed", orderId },
      "Worker finished order",
    );
  } catch (error) {
    const timedOut = error instanceof ErpTimeoutError;
    deps.logger.error(
      {
        event: timedOut ? "erp_timeout" : "erp_error",
        orderId,
        err: error,
      },
      timedOut ? "ERP timed out" : "ERP call failed",
    );

    if (deps.isLastAttempt) {
      await failOrderAndReleaseStock(orderId, deps.logger);
    } else {
      deps.logger.error(
        { event: "worker_retry", orderId, err: error },
        "Worker will retry order processing",
      );
    }

    throw error;
  }
}
