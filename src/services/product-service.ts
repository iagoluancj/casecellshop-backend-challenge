import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../lib/prisma.js";
import { ensureRedis, redis } from "../lib/redis.js";
import {
  cacheErrorsTotal,
  cacheHitsTotal,
  cacheMissesTotal,
} from "../observability/metrics.js";

export type PublicProduct = {
  id: string;
  name: string;
  price: string;
  stock: number;
};

export const PRODUCTS_CACHE_KEY = "products:list";

const DEFAULT_TTL_SECONDS = 30;

let inflightListProducts: Promise<PublicProduct[]> | null = null;

function productsCacheTtlSeconds(): number {
  const parsed = Number(process.env.PRODUCTS_CACHE_TTL_SECONDS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_TTL_SECONDS;
}

async function loadProductsFromDatabase(): Promise<PublicProduct[]> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      price: true,
      stock: true,
    },
    orderBy: {
      name: "asc",
    },
  });

  return products.map((product) => ({
    id: product.id,
    name: product.name,
    price: product.price.toFixed(2),
    stock: product.stock,
  }));
}

async function readProductsCache(
  logger: FastifyBaseLogger,
): Promise<
  | { status: "hit"; products: PublicProduct[] }
  | { status: "miss" }
  | { status: "error" }
> {
  try {
    const connected = await ensureRedis(logger);
    if (!connected) {
      logger.error(
        { event: "products_cache_error" },
        "Redis unavailable, falling back to PostgreSQL",
      );
      cacheErrorsTotal.inc();
      return { status: "error" };
    }

    const raw = await redis.get(PRODUCTS_CACHE_KEY);
    if (raw === null) {
      return { status: "miss" };
    }

    return { status: "hit", products: JSON.parse(raw) as PublicProduct[] };
  } catch (error) {
    logger.error(
      { event: "products_cache_error", err: error },
      "Redis get failed, falling back to PostgreSQL",
    );
    cacheErrorsTotal.inc();
    return { status: "error" };
  }
}

async function writeProductsCache(
  products: PublicProduct[],
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    const connected = await ensureRedis(logger);
    if (!connected) {
      logger.error(
        { event: "products_cache_error" },
        "Redis unavailable, skip cache write",
      );
      cacheErrorsTotal.inc();
      return;
    }

    await redis.set(PRODUCTS_CACHE_KEY, JSON.stringify(products), {
      EX: productsCacheTtlSeconds(),
    });
  } catch (error) {
    logger.error(
      { event: "products_cache_error", err: error },
      "Redis set failed",
    );
    cacheErrorsTotal.inc();
  }
}

export async function invalidateProductsCache(
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    const connected = await ensureRedis(logger);
    if (!connected) {
      logger?.error(
        { event: "products_cache_error" },
        "Redis unavailable, skip cache invalidation",
      );
      cacheErrorsTotal.inc();
      return;
    }

    await redis.del(PRODUCTS_CACHE_KEY);
  } catch (error) {
    logger?.error(
      { event: "products_cache_error", err: error },
      "Redis del failed",
    );
    cacheErrorsTotal.inc();
  }
}

export async function listProducts(
  logger: FastifyBaseLogger,
): Promise<PublicProduct[]> {
  const cached = await readProductsCache(logger);

  if (cached.status === "hit") {
    logger.info({ event: "products_cache_hit" }, "Products catalog cache hit");
    cacheHitsTotal.inc();
    return cached.products;
  }

  if (!inflightListProducts) {
    inflightListProducts = (async () => {
      if (cached.status === "miss") {
        logger.info(
          { event: "products_cache_miss" },
          "Products catalog cache miss",
        );
        cacheMissesTotal.inc();
      }

      const products = await loadProductsFromDatabase();
      await writeProductsCache(products, logger);
      return products;
    })().finally(() => {
      inflightListProducts = null;
    });
  }

  return inflightListProducts;
}
