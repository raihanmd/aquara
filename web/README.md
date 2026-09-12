# Aquara Web - dashboard + agent backend

The user-facing half of Aquara: see 1inch Aqua positions truthfully, deploy capital with live progress, authorize the scoped agent key, and serve the rotation signal that the cron consumes. Next.js on Base mainnet.

## What lives here

- **Dashboard** (`app/`): position cards with honest badges (In Range / Out of Range / Idle / Illiquid, Rotate recommended), tops leaderboard, deploy dialog, delegation flow, activity history.
- **Rotation signal** (`app/api/rotation/signal` + `lib/rotation.ts`): the single source of truth for cards AND cron - verdicts, trash rules, gain gate, spot-vs-band OOR proof.
- **Deploy pipeline** (`app/api/agent/deploy`): the one execution path used by both the dialog and the rotator - budget clamp, cover swaps, per-leg sims, atomic batches, ship.
- **Shared quoter** (`lib/oneinch-quote.ts`): the only 1inch swap/quote caller both web and rotator use.
- **Relayer** (`lib/calibur-agent.ts`): Calibur batching, nonce/seq floors, fee policy.
- **DB** (Prisma/Postgres): jobs, decisions, strategies (with shipped bands), per-maker settings.

## Run manually

```bash
bun install                          # from repo root (workspaces)
docker compose up -d                 # postgres only (dev profile, default)
cp .env.example .env                 # fill below
bunx prisma migrate dev
bun dev                              # :3000  (or: bun run dev:web from root)
```

## Run via Docker (GHCR image)

```bash
TAG=v1.2.3 WEB_IMAGE=ghcr.io/<owner>/aquara-web docker compose --profile ghcr up -d
# App at http://localhost:3677. Image built by .github/workflows/docker-web.yml
# on every v*.*.* tag touching web/**.
```

## Env

| Var                                    | Where          | Purpose                                                                                    |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                         | server         | Postgres connection (compose default works for dev)                                        |
| `ONEINCH_API_KEY`                      | server-only    | All Aqua/price/swap reads; never reaches the browser (all via `/api/*`)                    |
| `NEXT_PUBLIC_RPC_URL`                  | baked at build | Alchemy RPC for reads + sims                                                               |
| `NEXT_PUBLIC_CHAIN_ID`                 | baked at build | `8453`                                                                                     |
| `NEXT_PUBLIC_AGENT_ADDRESS`            | baked at build | Keeper key identity                                                                        |
| `RELAYER_PRIVATE_KEY`                  | server-only    | Agent private key                                                                          |
| `RELAYER_GAS_MULT_BPS`                 | server (opt)   | Fee multiplier, 50-500, default 100                                                        |
| `CRON_API_KEY`                         | server-only    | Accepts rotator's `x-cron-key`; must equal rotator `ROT_CRON_KEY` (`openssl rand -hex 32`) |
| `TRASH_*`                              | server (opt)   | Signal thresholds (volumes, APY, grace, efficiency) - full list in `.env.example`          |
| `TRASH_GAS_USD` / `TRASH_MIN_GAIN_BPS` | server (opt)   | Card gain gate; match rotator's `ROT_*` twins unless intentional                           |
| `QUOTE_SANITY_PCT`                     | server (opt)   | Reject swaps drifting past this % off price-implied value (default 25)                     |
| `AQUA_DEV_GAP_MS`                      | dev only (opt) | Pacing gap between upstream 1inch calls (prod gap is 0)                                    |

`NEXT_PUBLIC_*` are baked into the Docker image at build time (see workflow build-args). Everything else is runtime - pass via `--env-file .env`.
