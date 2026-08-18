#!/bin/sh
# Startup inside the API container:
# 1. apply versioned Prisma migrations (never migrate dev)
# 2. idempotent catalog seed (no Orders; does not reset stock)
# 3. start Fastify + Outbox Publisher + Worker + Reconciler
set -eu

echo "Applying Prisma migrations (deploy)..."
pnpm exec prisma migrate deploy

echo "Seeding catalog (idempotent)..."
pnpm exec prisma db seed

echo "Starting API..."
exec node dist/server.js
