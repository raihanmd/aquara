# syntax=docker/dockerfile:1.7
# Context MUST be the repo root (bun workspaces: the canonical lockfile is
# the root bun.lock; web/bun.lock is a stale leftover and is NOT used).

# ---- base ----
FROM oven/bun:1.4.0 AS base
WORKDIR /app

COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
COPY rotator/package.json ./rotator/package.json
COPY taker-bot/package.json ./taker-bot/package.json
RUN bun install --frozen-lockfile

# ---- builder ----
FROM base AS builder
WORKDIR /app
COPY web ./web

# DATABASE_URL is runtime-only; use dummy for prisma generate at build time
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public"
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/web
RUN bunx prisma generate

ARG NEXT_PUBLIC_CHAIN_ID=8453
ARG NEXT_PUBLIC_AGENT_ADDRESS=0xA0A2a81f3295566c5FA56784629cF2bd5F90C5a4
ARG NEXT_PUBLIC_RPC_URL
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID
ENV NEXT_PUBLIC_AGENT_ADDRESS=$NEXT_PUBLIC_AGENT_ADDRESS
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL

RUN bun run build

# ---- runner ----
FROM oven/bun:1.4.0-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# curl for HEALTHCHECK; oven/bun images already ship a non-root `bun` user
# (the -slim variant has no addgroup/adduser binaries, so reuse it)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/package.json ./package.json
COPY --from=base /app/bun.lock ./bun.lock
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/web/node_modules ./web/node_modules
COPY --from=base /app/web/tsconfig.json ./web/tsconfig.json
COPY --from=base /app/web/package.json ./web/package.json
COPY --from=builder /app/web/prisma ./web/prisma
COPY --from=builder /app/web/next.config.ts ./web/next.config.ts
COPY --from=builder /app/web/.next ./web/.next
WORKDIR /app/web

# Regenerate prisma client for runner arch (deps already present, no reinstall)
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public" bunx prisma generate \
  && chown -R bun:bun /app

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/ > /dev/null || exit 1

CMD ["sh", "-c", "bunx prisma migrate deploy || true; bun run start"]
