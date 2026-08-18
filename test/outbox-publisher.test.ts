import type { Queue } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import { publishPendingOutbox } from "../src/background/outbox-publisher.js";
import { prisma } from "../src/lib/prisma.js";
import {
  createPendingOrder,
  createProduct,
  resetDatabase,
  silentLogger,
} from "./helpers.js";

const logger = silentLogger();

describe("Outbox publisher", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("publica evento PENDING com jobId determinístico e marca PUBLISHED", async () => {
    const product = await createProduct({
      name: "Capinha Outbox",
      price: "10.00",
      stock: 2,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    const outbox = await prisma.outboxEvent.create({
      data: {
        orderId: order.id,
        type: "PROCESS_ORDER",
        payload: { orderId: order.id, correlationId: "corr-outbox-ok" },
      },
    });

    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const queue = {
      async add(name: string, data: unknown, opts: unknown) {
        added.push({ name, data, opts });
        return { id: outbox.id };
      },
    } as unknown as Queue;

    await publishPendingOutbox(queue, logger);

    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe("process-order");
    expect(added[0]?.data).toEqual({
      orderId: order.id,
      outboxEventId: outbox.id,
      correlationId: "corr-outbox-ok",
    });
    expect(added[0]?.opts).toMatchObject({ jobId: outbox.id, attempts: 3 });

    const published = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: outbox.id },
    });
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).not.toBeNull();
  });

  it("mantém PENDING e incrementa attempts se a fila falhar", async () => {
    const product = await createProduct({
      name: "Capinha Outbox Falha",
      price: "10.00",
      stock: 2,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    const outbox = await prisma.outboxEvent.create({
      data: {
        orderId: order.id,
        type: "PROCESS_ORDER",
        payload: { orderId: order.id },
      },
    });

    const queue = {
      async add() {
        throw new Error("Redis unavailable");
      },
    } as unknown as Queue;

    await publishPendingOutbox(queue, logger);

    const pending = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: outbox.id },
    });
    expect(pending.status).toBe("PENDING");
    expect(pending.attempts).toBe(1);
    expect(pending.publishedAt).toBeNull();
  });
});
