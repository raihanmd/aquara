# Taker Bot — demo volume engine for our own positions

Small positions never see organic flow. This service manufactures it honestly:
it fills **our own** Aqua strategies as a taker, so volume and taker fees
accrue visibly during a demo. Every tick is allowlisted, budgeted, simulated,
and logged — skips cost zero gas, and a skip is the rotation signal.

## Demo script

```bash
cp .env.example .env   # maker, taker key, strategy allowlist, one route
bun run src/index.ts
# watch ticks fill, then:
curl http://localhost:3101/status   # config + last 50 ticks with reasons
```

Point it at a funded position and within a few intervals the dashboard card
shows growing volume + earned. That is the whole demo.

## How a tick works

1. Route must be in `BOT_STRATEGIES` and within budget/caps, else refused.
2. Fetch the strategy's real shipped bytes (salt included) + decode the order.
3. Taker allowance to `AquaSwapVMRouter` (auto-approved in live, reported in dry-run).
4. `quote()` simulation — revert means depleted/OOR → skip, no gas spent.
5. Deviation + gas-economics gates (USD-based; bypassable for demo).
6. `swap()` submit in live only: `exactIn` (fixed input), `exactOut` (fixed
   output + threshold), drain (`"max"`: whole side until depleted, then skips).
7. Rich log line + `/status` ring buffer. Crashes become `decision=error`,
   never silent.

## Config (see `.env.example` for the annotated full list)

`BOT_MAKER` (only touchable maker) · `BOT_TAKER` · `BOT_TAKER_KEY`/`BOT_PK` ·
`BOT_LIVE` (anything but `true` = dry-run, submits nothing) ·
`BOT_INTERVAL_MS` · `BOT_MAX_TICKS_PER_DAY` · `BOT_TICK_BUDGET_USD` ·
`BOT_STRATEGIES` (hash allowlist = primary safety boundary) ·
`BOT_ROUTES` (JSON: strategy, tokenIn, amountRaw wei or `"max"`, sizeUsd) ·
`BOT_1INCH_KEY` (reads only).

Back-and-forth volume = two routes, opposite directions, same strategy.

## Scaling law (learned live)

A tick must be ≤ ~2% of position depth (else it blows through the band and
self-OORs) AND ≥ ~$0.80 (else gas exceeds fee). Positions under ~$50 cannot
sustain $1 loops — fund accordingly.

## Endpoints

- `GET /health` — liveness + counters.
- `GET /status` — config + recent ticks.
