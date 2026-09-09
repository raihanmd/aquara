# rotate-positions — CRE decides, BE executes (simulate-only)

No DON deploy needed. The workflow always evaluates candidates and POSTs to `beDeployUrl` when gates pass. In `cre workflow simulate` this hits the staging/local web directly — zero gas, no registry.

## What it does

Cron every 15 min (`*/15 * * * *`) per `config.*.json`:

1. Reads `GET /users` + `GET /strategies?maker=` + `GET /aqua/positions?maker=` (HTTPClient)
2. Recomputes watch verdicts (`healthy|depleted|side-depleted|oor-suspect|thin-allowance|unreadable`) + `trash` (volume/APY/demo flags) via EVM multicall (bigint only, WASM-safe, real selectors `0x6d58b4cc`/`0x44aa5f14`/`0x82ad56cb`)
3. Filters candidates: `aggressive AND (rotationCandidate OR trash) AND AI HIGH (when aiEnabled) AND gain>minGainMultipleBps AND dailyGasCap AND maxRotationsPerDay`
4. POSTs to `beDeployUrl` (`/api/agent/deploy`) with `x-api-key: CRE_API_KEY` from Vault DON secret `CRE_API_KEY` when all gates pass
5. Logs `skip` with reason otherwise; `POST ok` / `POST failed` on attempt

Kill-switch: makers with zero `aggressive` rows are skipped entirely. Delete the aggressive row via `DELETE /api/strategies?strategyHash=&maker=` with `x-api-key` to stop rotations for that position.

## Simulate (no DON deploy, zero gas)

From `cre/aquara-watch`:

```bash
# staging (default)
cre workflow simulate ./rotate-positions --target staging-settings -e .env

# production
cre workflow simulate ./rotate-positions --target production-settings -e .env
```

`.env` must provide `BASE_RPC_URL` (for `ethereum-mainnet-base-1`) and `CRE_API_KEY_VAR` / `AI_API_KEY_VAR` via `secrets.yaml` mapping. Simulate resolves Vault secrets from `.env` — no upload needed.

Expected logs:

```
[rotate] makers from api=1
[rotate] maker=0x08Dc... aggressiveRows=2 totalRows=3
[rotate] POST ok hash=0xabc... status=200
[rotate] skip maker=0x08Dc... hash=0xdef... reason=skip: not candidate ...
[rotate] summary makers=1 decisions=3 wouldRotate=1 executed=1
```

`wouldRotate` counts candidates that passed all gates; `executed` counts successful POSTs.

## Config reference

Every key in `config.*.json`:

| Key | Type | Default (staging / production) | What it does |
|-----|------|-------------------------------|--------------|
| `schedule` | string (cron) | `*/15 * * * *` / same | Cron trigger, 15 min |
| `makers` | `string[]` | `["0x08Dc..."]` / same | Fallback makers if `GET /users` fails |
| `apiBase` | string (URL) | `https://aquara.raihanmd.xyz/api` / same | Base for `GET /users`, `/strategies`, `/aqua/positions` |
| `beDeployUrl` | string (URL) | `https://aquara.raihanmd.xyz/api/agent/deploy` / same | POST target for rotations; expects `{maker,strategyHash,pair,mode,reason}` with `x-api-key` |
| `router` | string (address) | `0x111111338c5091e8440b67b168bae16a668ac0de` / same | 1inch router for `quote` EVM call |
| `aquaRegistry` | string (address) | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` / same | Aqua registry for `rawBalances` |
| `app` | string (address) | `0x111111338c5091e8440b67b168bae16a668ac0de` / same | Aqua app address for `rawBalances` |
| `probeAmountRaw` | string (uint) | `"100000"` / same | Probe amount for `quote` (raw units) |
| `chainSelectorName` | string | `ethereum-mainnet-base-1` / same | Chain selector for EVMClient (Base) |
| `aiApiUrl` | string (URL) | `https://ai.raihanmd.xyz/v1/chat/completions` / same | AI endpoint (OpenAI-compatible) |
| `aiModel` | string | `n8n-1` / same | Model name for AI request |
| `aiApiKeySecretId` | string | `AI_API_KEY` / same | Vault DON secret id for AI key |
| `aiApiKeyOwner` | string (address) | `0x5235...090` / same | Vault owner for AI secret |
| `aiEnabled` | boolean | `true` / `true` | If false, skip AI gate (all candidates pass AI) |
| `trashMinVolumeUsd` | number | `0.2` / `0.2` | Aggressive with 24h volume < this is `trash` (`low-volume-24h`) |
| `trashMaxApyPct` | `number \| null` | `null` / `null` | If not null, aggressive with APY < this is `trash` (`low-apy`); `null` disables |
| `trashZeroVolumeBothWindows` | boolean | `true` / `true` | If true, aggressive with 0 volume in both 24h and 7d is `trash` (`zero-volume-both-windows`) |
| `demoForceTrashHashes` | `string[]` | `[]` / `[]` | Strategy hashes always forced to `trash` (`demo-force`), case-insensitive |
| `demoTrashAllAggressive` | boolean | `false` / `false` | If true, every aggressive is `trash` (`demo-all`) |
| `maxRotationsPerDay` | number | `1` / `1` | Per-position daily cap (key `YYYY-MM-DD:hash`) |
| `dailyGasCapUsd` | number | `1.0` / `1.0` | Global daily gas cap in USD (key `YYYY-MM-DD`) |
| `minGainMultipleBps` | number | `20000` / `20000` | Gain must be >= this bps of gas (20000 = 2.00x). Uses scaled-integer `gain/gas*10000` |
| `gasCostUsd` | number | `0.08` / `0.08` | Estimated gas cost per rotation in USD (Base ~0.00002 ETH * $4000) |
| `estGainBpsOfQuoted` | number | `50` / `50` | Estimated gain as bps of `quotedOut` (50 = 0.5%). `estimatedGainUsd = quotedOut/1e6 * estGainBpsOfQuoted/10000` (assumes 6-decimal USD token; rough) |
| `creApiKeySecretId` | string | `CRE_API_KEY` / same | Vault DON secret id for `x-api-key` header |

WASM-safe: no `viem`, no `1inch SDK`, no Node built-ins. Secrets as references only (`runtime.getSecret`).

## Gain / gas math

```
quotedOut (raw, e.g. USDC 6 decimals) -> quotedOut / 1e6 = USD notional
estimatedGainUsd = (quotedOut / 1e6) * (estGainBpsOfQuoted / 10000)
gasCostUsd = gasCostUsd (config, default 0.08)
bps = estimatedGainUsd / gasCostUsd * 10000
pass if bps >= minGainMultipleBps (default 20000 = 2x)
```

Example: `quotedOut=2000000` (2 USDC), `estGainBpsOfQuoted=50` => `gain=2 * 0.005 = 0.01 USD`, `gas=0.08` => `bps=1250` => fail (needs 20000). With `quotedOut=200000000` (200 USDC) => `gain=1.0` => `bps=125000` => pass.

Tune `estGainBpsOfQuoted` and `gasCostUsd` to match real pool economics; `minGainMultipleBps` sets strictness.

## AI hash handling

Prompt demands full 66-char `0x` strategyHash in reply: `[{"hash":"0x...64 hex...","level":"LOW|MEDIUM|HIGH"}]`. Parser accepts full hashes and maps truncated 10-char prefixes to full hashes as fallback (logs `[rotate] ai fallback: mapped truncated ...` when used). This fixes the prior truncation bug where `N/N` classified.

Input lines now send full hashes: `0xabc... (66 chars) pair verdict ...`.

## Side-depleted

Implemented like `watch-positions`: if token data carries `initialBalance.raw` and `currentBalance.raw`, `side-depleted` triggers when any token has `initial > 0` and `current == 0`. If no token carries `initialBalance`, `side-depleted` never fires (no dead branch).

## Example cases

### (a) Normal ops — strict

Default config, no demo flags. Only truly unhealthy or trash aggressive positions with AI HIGH and gain>2x gas rotate.

```json
{
  "trashMinVolumeUsd": 0.2,
  "demoForceTrashHashes": [],
  "demoTrashAllAggressive": false,
  "aiEnabled": true,
  "minGainMultipleBps": 20000,
  "gasCostUsd": 0.08,
  "estGainBpsOfQuoted": 50
}
```

Simulate:

```bash
cre workflow simulate ./rotate-positions --target staging-settings -e .env
```

Expect: most positions `skip: not candidate` or `skip: AI not HIGH` or `skip: gain gate fail`; only `POST ok` for high-urgency trash with sufficient quotedOut.

### (b) Demo — force-trash one position

Force a single known hash to trash regardless of volume/APY, to demo the full pipeline for that position.

```json
{
  "demoForceTrashHashes": ["0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"],
  "demoTrashAllAggressive": false,
  "trashMinVolumeUsd": 0.2,
  "aiEnabled": true
}
```

Simulate:

```bash
cre workflow simulate ./rotate-positions --target staging-settings -e .env
```

Expect: that hash gets `trash=true trashReason=demo-force`, then if AI HIGH and gain passes, `POST ok` for that hash only; others follow normal rules.

### (c) Demo — trash-all-aggressive

Trash every aggressive position and use high volume threshold to show aggressive filtering.

```json
{
  "demoTrashAllAggressive": true,
  "trashMinVolumeUsd": 999999,
  "aiEnabled": true,
  "minGainMultipleBps": 1000,
  "gasCostUsd": 0.01,
  "estGainBpsOfQuoted": 500
}
```

Simulate:

```bash
cre workflow simulate ./rotate-positions --target staging-settings -e .env
```

Expect: all aggressive positions `trash=true trashReason=demo-all`, gain gate relaxed (`minGainMultipleBps=1000` = 0.1x, `gasCostUsd=0.01`, `estGainBpsOfQuoted=500` = 5%), so many `POST ok` (bounded by `maxRotationsPerDay` and `dailyGasCapUsd`).

## Kill switch

```bash
curl -X DELETE "https://aquara.raihanmd.xyz/api/strategies?strategyHash=0x...&maker=0x..." \
  -H "x-api-key: $CRE_API_KEY"
```

Deleting the aggressive row makes the next tick skip that maker/position (kill-switch check). No code deploy needed.

## Daily counters — in-memory + follow-up

Current: `Map` keyed by `YYYY-MM-DD` and `YYYY-MM-DD:hash`, reset on UTC midnight. DON instances are ephemeral; a cold start resets counters.

Follow-up for durability: persist to Redis or DB (e.g. `prisma.agentDecision.count({ where: { maker, strategyHash, createdAt: { gte: startOfDay } } })` and `sum gasCostUsd`). Documented in `main.ts` `resetDailyIfNeeded()`.

## Secrets

`../secrets.yaml` must contain:

```yaml
secretsNames:
  AI_API_KEY:
    - AI_API_KEY_VAR
  CRE_API_KEY:
    - CRE_API_KEY_VAR
```

Do not commit values. `CRE_API_KEY_VAR` is the env var holding the BE `x-api-key`. Simulate resolves via `-e .env`.

## Verification

- `cre workflow simulate ./rotate-positions --target staging-settings -e .env` must compile and run with no legacy mode strings in dir.
- No `as any`, no Node imports, no `viem`.
- Logs show `POST ok`/`POST failed`/`skip` with reason, never `would-rotate`.
```

