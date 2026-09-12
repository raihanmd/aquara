# syntax=docker/dockerfile:1.7
# Aquara taker-bot (Bun service): scheduled self-fills for demo volume.
# Context MUST be the repo root (shared workspace layout).
# All config is runtime env (BOT_*); nothing is baked in. Run with:
#   docker run -p 3101:3101 --env-file taker-bot/.env ghcr.io/<owner>/aquara-taker-bot:latest

# ---- base ----
FROM oven/bun:1.4.0 AS base
WORKDIR /app

COPY package.json bun.lock ./
COPY taker-bot/package.json ./taker-bot/package.json
RUN bun install --frozen-lockfile

COPY taker-bot/src ./taker-bot/src

# ---- runner ----
FROM oven/bun:1.4.0-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3101
ENV BOT_PORT=3101

# curl for HEALTHCHECK; oven/bun images already ship a non-root `bun` user
# (the -slim variant has no addgroup/adduser binaries, so reuse it)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/package.json ./package.json
COPY --from=base /app/bun.lock ./bun.lock
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/taker-bot/src ./taker-bot/src
COPY --from=base /app/taker-bot/package.json ./taker-bot/package.json
# Workspace symlink dirs (taker-bot/node_modules/* -> ../../node_modules/.bun/...)
COPY --from=base /app/taker-bot/node_modules ./taker-bot/node_modules

RUN chown -R bun:bun /app

USER bun

EXPOSE 3101

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3101/health > /dev/null || exit 1

CMD ["bun", "taker-bot/src/index.ts"]
