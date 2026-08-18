import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Verifica se a API está no ar",
        response: {
          200: {
            description: "API disponível",
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string", enum: ["ok"] },
            },
            additionalProperties: false,
            example: { status: "ok" },
          },
        },
      },
    },
    async () => {
      return { status: "ok" };
    },
  );
}
