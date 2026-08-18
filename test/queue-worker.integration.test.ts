import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { startOrderWorker } from "../src/background/order-worker.js";
import { publishPendingOutbox } from "../src/background/outbox-publisher.js";
import { FakeErp } from "../src/integrations/fake-erp.js";
import { createBullmqConnection, createOrderQueue } from "../src/lib/bullmq.js";
import { prisma } from "../src/lib/prisma.js";
import {
  createProduct,
  resetDatabase,
  silentLogger,
  waitForOrderStatus,
} from "./helpers.js";

describe("Queue → Worker (Redis)", () => {
  let app: FastifyInstance;
  const logger = silentLogger();
  const prefix = "casecellshop-test";
  const connection = createBullmqConnection();
  const queue = createOrderQueue(connection, { prefix });
  let worker: ReturnType<typeof startOrderWorker> | undefined;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    if (worker) {
      await worker.close();
    }
    await queue.close();
    if (connection.status !== "end") {
      await connection.quit();
    }
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    await queue.obliterate({ force: true });
    if (worker) {
      await worker.close();
      worker = undefined;
    }
  });

  it("publica o outbox e o worker completa o pedido", async () => {
    const erp = new FakeErp({ mode: "success" });
    worker = startOrderWorker(logger, erp, { prefix });
    await worker.worker.waitUntilReady();

    const product = await createProduct({
      name: "Capinha Fila",
      price: "10.00",
      stock: 5,
    });

    const response = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        items: [{ productId: product.id, quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(202);
    const { orderId } = response.json() as { orderId: string };

    await publishPendingOutbox(queue, logger);
    await waitForOrderStatus(orderId, "COMPLETED");

    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { orderId },
    });
    expect(outbox.status).toBe("PUBLISHED");
    expect(erp.wasProcessed(orderId)).toBe(true);
  });

  it("esgota retries, marca FAILED e devolve o estoque", async () => {
    const erp = new FakeErp({ mode: "fail_always" });
    worker = startOrderWorker(logger, erp, { prefix });
    await worker.worker.waitUntilReady();

    const product = await createProduct({
      name: "Capinha Fila Falha",
      price: "10.00",
      stock: 4,
    });

    const response = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        items: [{ productId: product.id, quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(202);
    const { orderId } = response.json() as { orderId: string };

    await publishPendingOutbox(queue, logger);
    await waitForOrderStatus(orderId, "FAILED", 8000);

    const failed = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(failed.stockReleasedAt).not.toBeNull();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(4);
    expect(erp.wasProcessed(orderId)).toBe(false);
  }, 15_000);
});
