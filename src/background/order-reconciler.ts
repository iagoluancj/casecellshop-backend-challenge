import type { FastifyBaseLogger } from "fastify";
import {
  ORDER_RECONCILIATION_INTERVAL_MS,
  ORDER_RECONCILIATION_STALE_MS,
  OUTBOX_TYPE_PROCESS_ORDER,
} from "../config.js";
import type { FakeErp } from "../integrations/fake-erp.js";
import type { ProcessOrderOutboxPayload } from "../jobs/order-job.js";
import { prisma } from "../lib/prisma.js";
import { reconciliationTotal } from "../observability/metrics.js";

export type ReconcileOptions = {
  staleMs?: number;
};

function durationMsSince(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

async function correlationIdForOrder(orderId: string): Promise<string | undefined> {
  const event = await prisma.outboxEvent.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
  const payload = event?.payload as { correlationId?: string } | undefined;
  return payload?.correlationId;
}

async function markCompleted(
  orderId: string,
  logger: FastifyBaseLogger,
  correlationId: string | undefined,
  startedAt: bigint,
): Promise<void> {
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: "PROCESSING" },
    data: { status: "COMPLETED" },
  });

  if (claimed.count !== 1) {
    return;
  }

  reconciliationTotal.inc({ result: "completed" });
  logger.info(
    {
      event: "order_reconciliation_completed",
      orderId,
      correlationId,
      durationMs: durationMsSince(startedAt),
      result: "completed",
    },
    "Stale PROCESSING order marked COMPLETED from ERP",
  );
}

async function requeueUnknownOrder(
  orderId: string,
  logger: FastifyBaseLogger,
  correlationId: string | undefined,
  startedAt: bigint,
): Promise<void> {
  const payload: ProcessOrderOutboxPayload = {
    orderId,
    correlationId: correlationId ?? orderId,
  };

  const claimed = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: "PROCESSING" },
      data: { status: "PENDING" },
    });

    if (updated.count !== 1) {
      return false;
    }

    const pendingOutbox = await tx.outboxEvent.findFirst({
      where: { orderId, status: "PENDING" },
    });

    if (!pendingOutbox) {
      await tx.outboxEvent.create({
        data: {
          orderId,
          type: OUTBOX_TYPE_PROCESS_ORDER,
          payload,
        },
      });
    }

    return true;
  });

  if (!claimed) {
    return;
  }

  reconciliationTotal.inc({ result: "not_found" });
  logger.info(
    {
      event: "order_reconciliation_not_found",
      orderId,
      correlationId,
      durationMs: durationMsSince(startedAt),
      result: "not_found",
    },
    "ERP does not know the order; requeued as PENDING",
  );
}

export async function reconcileStaleOrders(
  erp: FakeErp,
  logger: FastifyBaseLogger,
  options: ReconcileOptions = {},
): Promise<void> {
  const staleMs = options.staleMs ?? ORDER_RECONCILIATION_STALE_MS;
  const staleBefore = new Date(Date.now() - staleMs);

  const orders = await prisma.order.findMany({
    where: {
      status: "PROCESSING",
      updatedAt: { lt: staleBefore },
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });

  for (const order of orders) {
    const startedAt = process.hrtime.bigint();
    const correlationId = await correlationIdForOrder(order.id);

    logger.info(
      {
        event: "order_reconciliation_started",
        orderId: order.id,
        correlationId,
      },
      "Reconciling stale PROCESSING order",
    );

    try {
      const erpStatus = await erp.getOrderStatus(order.id);

      if (erpStatus === "COMPLETED") {
        await markCompleted(order.id, logger, correlationId, startedAt);
        continue;
      }

      await requeueUnknownOrder(order.id, logger, correlationId, startedAt);
    } catch (error) {
      reconciliationTotal.inc({ result: "error" });
      logger.error(
        {
          event: "order_reconciliation_failed",
          orderId: order.id,
          correlationId,
          durationMs: durationMsSince(startedAt),
          result: "error",
          err: error,
        },
        "Order reconciliation failed",
      );
    }
  }
}

export function startOrderReconciler(
  erp: FakeErp,
  logger: FastifyBaseLogger,
  intervalMs = ORDER_RECONCILIATION_INTERVAL_MS,
) {
  let inFlight = false;

  const tick = () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void reconcileStaleOrders(erp, logger).finally(() => {
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
