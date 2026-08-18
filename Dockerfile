# Node 24: matches the local runtime (v24.15) and Prisma 7 / Fastify 5 requirements.
# Prisma 7.9 expects Node 20.19+, 22.12+ or 24+.
FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.1.3 --activate

COPY package.json pnpm-lock.yaml ./

# Skip lifecycle generate until schema and src/ are present.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY docker-entrypoint.sh ./

# prisma.config.ts calls env("DATABASE_URL"); generate does not connect.
ENV DATABASE_URL=postgresql://casecellshop:casecellshop@postgres:5432/casecellshop

RUN pnpm build \
  && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
