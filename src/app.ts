import Fastify, { type FastifyServerOptions } from "fastify";
import { healthRoutes } from "./routes/health.js";

export async function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: true,
    ...options,
  });

  await app.register(healthRoutes);

  return app;
}
