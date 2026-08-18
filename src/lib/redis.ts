import "dotenv/config";
import { createClient } from "redis";
import type { FastifyBaseLogger } from "fastify";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis = createClient({
  url: redisUrl,
});

redis.on("error", () => {
  // Prevents unhandled 'error' from crashing the process.
  // Cache read/write logs products_cache_error at the call site.
});

let connecting: Promise<boolean> | null = null;

export async function ensureRedis(logger?: FastifyBaseLogger): Promise<boolean> {
  if (redis.isOpen) {
    return true;
  }

  if (!connecting) {
    connecting = redis
      .connect()
      .then(() => true)
      .catch((error: unknown) => {
        logger?.error(
          { event: "products_cache_error", err: error },
          "Redis unavailable, falling back to PostgreSQL",
        );
        return false;
      })
      .finally(() => {
        connecting = null;
      });
  }

  return connecting;
}

export async function connectRedis(logger?: FastifyBaseLogger): Promise<void> {
  const connected = await ensureRedis(logger);
  if (connected) {
    logger?.info({ event: "redis_connected" }, "Redis connected");
  }
}

export async function closeRedis(): Promise<void> {
  if (redis.isOpen) {
    await redis.quit();
  }
}
