import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileStaleOrders } from "../src/background/order-reconciler.js";
import { FakeErp } from "../src/integrations/fake-erp.js";
import { prisma } from "../src/lib/prisma.js";
import { failOrderAndReleaseStock } from "../src/services/process-order-service.js";
import {
  createPendingOrder,
  createProduct,
  resetDatabase,
  silentLogger,
} from "./helpers.js";

const logger = silentLogger();
const STALE_MS = 5_000;

async function markProcessing(orderId: string) {
  await prisma.order.update({
    where: { id: orderId },
    data: { status: "PROCESSING" },
  });
}

async function markStale(orderId: string) {
  await prisma.$executeRaw`
    UPDATE "Order"
    SET "updatedAt" = NOW() - INTERVAL '1 hour'
    WHERE "id" = ${orderId}
  `;
}

describe("order reconciliation", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it("marca COMPLETED quando o ERP já processou um PROCESSING stale", async () => {
    const product = await createProduct({
      name: "Capinha Recon Completed",
      price: "10.00",
      stock: 4,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    await markProcessing(order.id);
    await markStale(order.id);

    const erp = new FakeErp({ mode: "success" });
    erp.markProcessed(order.id);

    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });

    const updated = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.stockReleasedAt).toBeNull();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3);
  });

  it("não interfere em Order PROCESSING recente", async () => {
    const product = await createProduct({
      name: "Capinha Recon Recente",
      price: "10.00",
      stock: 4,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    await markProcessing(order.id);

    const erp = new FakeErp({ mode: "success" });
    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });

    const updated = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updated.status).toBe("PROCESSING");
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it("recoloca PENDING e cria Outbox quando o ERP não conhece o pedido", async () => {
    const product = await createProduct({
      name: "Capinha Recon Not Found",
      price: "10.00",
      stock: 5,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 2,
    });
    await markProcessing(order.id);
    await markStale(order.id);

    const erp = new FakeErp({ mode: "success" });
    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });

    const updated = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updated.status).toBe("PENDING");
    expect(updated.stockReleasedAt).toBeNull();
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(
      (await prisma.outboxEvent.findFirstOrThrow({ where: { orderId: order.id } }))
        .status,
    ).toBe("PENDING");
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3);
  });

  it("não produz segundo efeito depois de Order já corrigida", async () => {
    const product = await createProduct({
      name: "Capinha Recon Idempotente",
      price: "10.00",
      stock: 4,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    await markProcessing(order.id);
    await markStale(order.id);

    const erp = new FakeErp({ mode: "success" });
    erp.markProcessed(order.id);

    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });
    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });

    const updated = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updated.status).toBe("COMPLETED");
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3);
  });

  it("não devolve estoque no NOT_FOUND; compensação definitiva ocorre só uma vez", async () => {
    const product = await createProduct({
      name: "Capinha Recon Estoque",
      price: "10.00",
      stock: 8,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 3,
    });
    await markProcessing(order.id);
    await markStale(order.id);

    const erp = new FakeErp({ mode: "success" });
    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });
    await reconcileStaleOrders(erp, logger, { staleMs: STALE_MS });

    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("PENDING");
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(5);

    const first = await failOrderAndReleaseStock(order.id, logger);
    const second = await failOrderAndReleaseStock(order.id, logger);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(8);
  });
});
