# Aquara Rotator - autonomous rotation cron

Bun + Hono service (`:3102`) that turns rotation signals into on-chain reality. Dry-run by default; live only with explicit `ROT_LIVE=true`. It executes the exact same deploy flow as the dashboard dialog - manual and autonomous can never disagree.

## What it does per tick (per maker)

1. **Evaluate** - pulls `/api/rotation/signal`, keeps eligible groups (max `ROT_GROUP_MAX_SIZE`), skips groups already sitting in a top pair.
2. **Snapshot** - raw balances + decimals straight from chain, pre-dock. Logs `virtual=X wallet=Y` per token so under-backed positions are visible before anything moves.
3. **Preflight** - allowance-free route check per merge leg. Missing route skips before any gas is spent.
4. **Approve** - one batched tx for every token missing router allowance (one-time per token).
5. **Dock** - cancels grouped intents (moves nothing; Aqua is self-custodial).
6. **Merge** - swaps every non-capital side into USDC (shared quoter, sim-before-send, measured deltas, 3x re-quote on volatility).
7. **Reconcile** - logs snapshot USD vs merged USD, flags drift beyond 3%.
8. **Deploy** - one `POST /api/agent/deploy` with the measured budget (clamped to wallet server-side).

## Run manually

```bash
cp rotator/.env.example rotator/.env   # fill below (needs web running)
bun run dev:rotator                    # from root; hot-reload. Live ONLY if ROT_LIVE=true
# Tick now:  curl -X POST localhost:3102/cron/tick -H 'Content-Type: application/json' -d '{"maker":"0x..."}'
# Inspect:   curl localhost:3102/status
```

## Run via Docker (GHCR image)

```bash
docker run -p 3102:3102 --env-file rotator/.env ghcr.io/<owner>/aquara-rotator:latest
# Image built by .github/workflows/docker-rotator.yml on every v*.*.*
# tag touching rotator/** or web/lib/** (the shared lib it imports).
```

## Env

| Var                                                        | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `ROT_WEB_BASE`                                             | Web backend URL (signals, tops, settings, deploy)                    |
| `ROT_RPC_URL`                                              | Alchemy RPC for reads/sims/sends. Required                           |
| `ROT_RELAYER_KEY`                                          | Agent private key                                                    |
| `ROT_CRON_KEY`                                             | Must equal web/ `CRON_API_KEY`                                       |
| `ROT_ONEINCH_KEY`                                          | 1inch key for merge/preflight quotes                                 |
| `ROT_LIVE`                                                 | Anything but exactly `true` = dry-run (decisions only, zero txs)     |
| `ROT_AI_*`                                                 | Advisor endpoint/model/key; advisory only, never vetoes dead capital |
| `ROT_MIN_GAIN_BPS` / `ROT_GAS_USD`                         | Execution-side gain re-gate (mirror web's `TRASH_*` twins)           |
| `ROT_GROUP_MAX_SIZE`                                       | Max positions per tick group                                         |
| `ROT_TOP_MAX_PAIRS` / `ROT_TOP_MIN_RATIO` / `ROT_TOP_MODE` | Destination selection (`apy` or `scored`)                            |
| `ROT_MAX_PER_DAY` / `ROT_DAILY_GAS_CAP_USD`                | Daily rotation and gas budgets                                       |
| `ROT_MIN_CAPITAL_USD`                                      | Groups worth less skip loudly instead of failing in swaps            |
| `ROT_INTERVAL_MS` / `ROT_PORT`                             | Schedule (`900000` = 15 min) and port (`3102`)                       |
| `ROT_AQUA` / `ROT_APP`                                     | Registry + app addresses (defaults are current Base mainnet)         |
