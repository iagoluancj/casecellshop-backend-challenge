import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { resolveCorrelationId } from "../observability/correlation.js";
import { httpRequestDurationSeconds } from "../observability/metrics.js";

const httpStartedAt = new WeakMap<FastifyRequest, bigint>();

function isScrapedOrDocs(request: FastifyRequest): boolean {
  const path = request.url.split("?")[0] ?? request.url;
  return path === "/metrics" || path.startsWith("/docs");
}

function routeLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? "unmatched";
}

const observabilityPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = resolveCorrelationId(
      request.headers["x-correlation-id"],
    );
    request.log = request.log.child({
      requestId: request.id,
      correlationId: request.correlationId,
    });
    reply.header("x-correlation-id", request.correlationId);
    httpStartedAt.set(request, process.hrtime.bigint());
  });

  app.addHook("onResponse", async (request, reply) => {
    const started = httpStartedAt.get(request);
    httpStartedAt.delete(request);
    if (started === undefined || isScrapedOrDocs(request)) {
      return;
    }

    const durationNs = process.hrtime.bigint() - started;
    const durationSeconds = Number(durationNs) / 1e9;
    const durationMs = durationSeconds * 1000;
    const labels = {
      method: request.method,
      route: routeLabel(request),
      status_code: String(reply.statusCode),
    };

    httpRequestDurationSeconds.observe(labels, durationSeconds);
    request.log.info(
      {
        event: "http_request_completed",
        requestId: request.id,
        correlationId: request.correlationId,
        method: request.method,
        url: labels.route,
        statusCode: reply.statusCode,
        durationMs,
      },
      "HTTP request completed",
    );
  });
};

export default fp(observabilityPlugin);
