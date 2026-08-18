import "dotenv/config";
import { Redis } from "ioredis";
import { Queue, type QueueOptions } from "bullmq";
import { ORDER_QUEUE_NAME } from "../config.js";

export type BullmqPrefixOptions = {
  prefix?: string;
};

// Cache uses node-redis (src/lib/redis.ts). The queue uses a dedicated ioredis
// connection because BullMQ workers require maxRetriesPerRequest: null.
export function createBullmqConnection(): Redis {
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

export function createOrderQueue(
  connection: Redis,
  options: BullmqPrefixOptions = {},
): Queue {
  const queueOptions: QueueOptions = { connection };
  if (options.prefix) {
    queueOptions.prefix = options.prefix;
  }
  return new Queue(ORDER_QUEUE_NAME, queueOptions);
}
