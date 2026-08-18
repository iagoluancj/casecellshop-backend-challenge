import type { FastifyInstance } from "fastify";
import { HttpError } from "../http-error.js";
import { prisma } from "../lib/prisma.js";

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
} as const;

export async function ordersRoutes(app: FastifyInstance) {
  app.get(
    "/orders/:orderId/status",
    {
      schema: {
        tags: ["Orders"],
        summary: "Consulta o status de processamento do pedido",
        params: {
          type: "object",
          required: ["orderId"],
          properties: {
            orderId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            description: "Status atual do pedido",
            type: "object",
            additionalProperties: false,
            required: ["orderId", "status"],
            properties: {
              orderId: { type: "string" },
              status: {
                type: "string",
                enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
              },
            },
          },
          404: {
            description: "Pedido não encontrado",
            ...errorResponseSchema,
          },
        },
      },
    },
    async (request) => {
      const { orderId } = request.params as { orderId: string };
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true },
      });

      if (!order) {
        throw new HttpError(404, "ORDER_NOT_FOUND", "Pedido não encontrado");
      }

      return {
        orderId: order.id,
        status: order.status,
      };
    },
  );
}
