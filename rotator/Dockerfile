# syntax=docker/dockerfile:1.7
# Aquara rotator (Bun cron): rotation evaluator + Calibur executor.
# Context MUST be the repo root: rotator imports ../../web/lib at runtime.
# All config is runtime env (ROT_*); nothing is baked in. Run with:
#   docker run -p 3102:3102 --env-file rotator/.env ghcr.io/<owner>/aquara-rotator:latest

# ---- base ----
FROM oven/bun:1.4.0 AS base
WORKDIR /app

COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
COPY rotator/package.json ./rotator/package.json
COPY taker-bot/package.json ./taker-bot/package.json
RUN bun install --frozen-lockfile

COPY web/tsconfig.json ./web/tsconfig.json
COPY web/lib ./web/lib
COPY rotator/src ./rotator/src

# ---- runner ----
FROM oven/bun:1.4.0-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3102
ENV ROT_PORT=3102

# curl for HEALTHCHECK; oven/bun images already ship a non-root `bun` user
# (the -slim variant has no addgroup/adduser binaries, so reuse it)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/package.json ./package.json
COPY --from=base /app/bun.lock ./bun.lock
COPY --from=base /app/node_modules ./node_modules
# web/tsconfig.json: bun resolves the `@/*` alias in web/lib from it at runtime
COPY --from=base /app/web/tsconfig.json ./web/tsconfig.json
COPY --from=base /app/web/lib ./web/lib
COPY --from=base /app/rotator/src ./rotator/src
COPY --from=base /app/rotator/package.json ./rotator/package.json
# Workspace symlink dirs (e.g. rotator/node_modules/hono -> ../../node_modules/.bun/...)
COPY --from=base /app/rotator/node_modules ./rotator/node_modules
COPY --from=base /app/web/node_modules ./web/node_modules

RUN chown -R bun:bun /app

USER bun

EXPOSE 3102

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3102/health > /dev/null || exit 1

CMD ["bun", "rotator/src/index.ts"]
