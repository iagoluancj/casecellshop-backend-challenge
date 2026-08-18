import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakeErp } from "../src/integrations/fake-erp.js";
import { prisma } from "../src/lib/prisma.js";
import {
  failOrderAndReleaseStock,
  processOrder,
} from "../src/services/process-order-service.js";
import {
  createPendingOrder,
  createProduct,
  resetDatabase,
  silentLogger,
} from "./helpers.js";

const logger = silentLogger();

describe("processOrder", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it("marca PROCESSING e depois COMPLETED quando o ERP confirma", async () => {
    const product = await createProduct({
      name: "Capinha Worker",
      price: "10.00",
      stock: 5,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 2,
    });

    const erp = new (class extends FakeErp {
      statusDuringCall?: string;
      override async processOrder(orderId: string, signal?: AbortSignal) {
        const current = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        this.statusDuringCall = current.status;
        return super.processOrder(orderId, signal);
      }
    })({ mode: "success" });

    await processOrder(order.id, {
      erp,
      logger,
      isLastAttempt: false,
    });

    expect(erp.statusDuringCall).toBe("PROCESSING");
    const completed = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(erp.wasProcessed(order.id)).toBe(true);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3);
  });

  it("faz retry em falha transitória e termina COMPLETED sem compensar estoque", async () => {
    const product = await createProduct({
      name: "Capinha Retry",
      price: "10.00",
      stock: 4,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    const erp = new FakeErp({ mode: "fail_times", times: 2 });

    await expect(
      processOrder(order.id, { erp, logger, isLastAttempt: false }),
    ).rejects.toThrow("ERP unavailable");
    await expect(
      processOrder(order.id, { erp, logger, isLastAttempt: false }),
    ).rejects.toThrow("ERP unavailable");
    await processOrder(order.id, { erp, logger, isLastAttempt: true });

    const completed = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.stockReleasedAt).toBeNull();
    expect(erp.getAttempts(order.id)).toBe(3);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3);
  });

  it("marca FAILED e devolve estoque só após a última tentativa", async () => {
    const product = await createProduct({
      name: "Capinha Fail",
      price: "10.00",
      stock: 6,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 2,
    });
    const erp = new FakeErp({ mode: "fail_always" });

    await expect(
      processOrder(order.id, { erp, logger, isLastAttempt: false }),
    ).rejects.toThrow("ERP unavailable");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("PROCESSING");
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(4);

    await expect(
      processOrder(order.id, { erp, logger, isLastAttempt: false }),
    ).rejects.toThrow("ERP unavailable");
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(4);

    await expect(
      processOrder(order.id, { erp, logger, isLastAttempt: true }),
    ).rejects.toThrow("ERP unavailable");

    const failed = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.stockReleasedAt).not.toBeNull();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(6);
  });

  it("não chama o ERP de novo se a Order já está COMPLETED", async () => {
    const product = await createProduct({
      name: "Capinha Idempotente",
      price: "10.00",
      stock: 3,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    const erp = new FakeErp({ mode: "success" });

    await processOrder(order.id, { erp, logger, isLastAttempt: false });
    expect(erp.getAttempts(order.id)).toBe(1);

    await processOrder(order.id, { erp, logger, isLastAttempt: false });

    expect(erp.getAttempts(order.id)).toBe(1);
    expect(erp.wasProcessed(order.id)).toBe(true);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("COMPLETED");
  });

  it("compensa estoque apenas uma vez", async () => {
    const product = await createProduct({
      name: "Capinha Compensação",
      price: "10.00",
      stock: 8,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 3,
    });

    const first = await failOrderAndReleaseStock(order.id, logger);
    const second = await failOrderAndReleaseStock(order.id, logger);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(8);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("FAILED");
  });

  it("trata timeout do ERP como falha transitória", async () => {
    const product = await createProduct({
      name: "Capinha Timeout",
      price: "10.00",
      stock: 2,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    const erp = new FakeErp({ mode: "timeout", delayMs: 200 });

    await expect(
      processOrder(order.id, {
        erp,
        logger,
        isLastAttempt: false,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("ERP timeout");

    expect(erp.wasProcessed(order.id)).toBe(false);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("PROCESSING");
  });
});
