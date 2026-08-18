import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../src/lib/prisma.js";

export function silentLogger(): FastifyBaseLogger {
  const logger = {
    level: "silent",
    silent: true,
    info() {},
    error() {},
    warn() {},
    debug() {},
    fatal() {},
    trace() {},
    child() {
      return logger;
    },
  };

  return logger as unknown as FastifyBaseLogger;
}

export async function resetDatabase() {
  await prisma.outboxEvent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
}

export async function createProduct(data: {
  name: string;
  price: string;
  stock: number;
}) {
  return prisma.product.create({
    data: {
      externalId: `test-${randomUUID()}`,
      name: data.name,
      price: data.price,
      stock: data.stock,
    },
  });
}

export async function createPendingOrder(data: {
  productId: string;
  quantity: number;
  unitPrice?: string;
}) {
  const quantity = data.quantity;
  const unitPrice = data.unitPrice ?? "10.00";

  const order = await prisma.order.create({
    data: {
      idempotencyKey: randomUUID(),
      requestFingerprint: "test-fingerprint",
      status: "PENDING",
      total: (Number(unitPrice) * quantity).toFixed(2),
      items: {
        create: {
          productId: data.productId,
          quantity,
          unitPrice,
        },
      },
    },
  });

  await prisma.product.update({
    where: { id: data.productId },
    data: { stock: { decrement: quantity } },
  });

  return order;
}

export async function waitForOrderStatus(
  orderId: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED",
  timeoutMs = 5000,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order?.status === status) {
      return order;
    }
    if (
      (order?.status === "COMPLETED" || order?.status === "FAILED") &&
      order.status !== status
    ) {
      throw new Error(
        `Expected order ${orderId} to become ${status}, but it finished as ${order.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const latest = await prisma.order.findUnique({ where: { id: orderId } });
  throw new Error(
    `Timed out waiting for order ${orderId} to become ${status}. Last status: ${latest?.status}`,
  );
}
