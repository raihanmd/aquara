# syntax=docker/dockerfile:1.7

# ---- base ----
FROM oven/bun:1.4.0 AS base
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- builder ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# DATABASE_URL is runtime-only; use dummy for prisma generate at build time
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public"
ENV NEXT_TELEMETRY_DISABLED=1
RUN bunx prisma generate

ARG NEXT_PUBLIC_CHAIN_ID=8453
ARG NEXT_PUBLIC_AGENT_ADDRESS=0x5235401AbA9b0f597A19B48497bf174a4dA8A090
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

# curl for HEALTHCHECK; create non-root user
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# public may be empty; copy if exists (builder always has it, even if empty)
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bun.lock ./bun.lock
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/.next ./.next

# Install production deps only and regenerate prisma client for runner arch
RUN bun install --frozen-lockfile --production \
  && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public" bunx prisma generate

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/ > /dev/null || exit 1

CMD ["sh", "-c", "bunx prisma migrate deploy || true; bun run start"]
