import type { FastifyInstance } from "fastify";
import {
  metricsRegistry,
  renderMetrics,
} from "../observability/metrics.js";

export async function metricsRoutes(app: FastifyInstance) {
  app.get(
    "/metrics",
    {
      schema: {
        hide: true,
      },
    },
    async (_request, reply) => {
      const body = await renderMetrics();
      return reply.header("Content-Type", metricsRegistry.contentType).send(body);
    },
  );
}
