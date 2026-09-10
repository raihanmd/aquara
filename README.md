# Aquara — Delegate once, stay in range on 1inch Aqua

**Delegate once: Aquara turns any Base wallet into a self-managing 1inch Aqua position that stays in range without custody.**

Live on **Base mainnet** (chain 8453), built on **1inch Aqua** + **Calibur** (EIP-7702 smart wallets).

## 90-second demo

1. **Connect + Delegate** — open the dashboard, click _Delegate to agent_, sign once. Your EOA becomes a Calibur smart wallet and authorizes our agent key for 30 days. The key can only touch an explicit whitelist (Aqua ship/dock, token approvals, 1inch router). Revoke anytime.
2. **Deploy** — pick a pair (e.g. USDC/WETH), choose Stable or Aggressive, Deploy. Watch live progress: planning → swaps → ship → on-chain position.
3. **Earn** — (demo only) run the taker bot once: it fills your own position, volume and taker fees accrue on the card within minutes.

## How it fits together

```
wallet (Calibur 7702) ── scoped key ──▶ agent relayer ──▶ Aqua (ship/dock/pull/push)
```

- No custody: tokens never leave your wallet (Aqua allowance model).
- Every number on screen traces to chain or the 1inch API.
- A Bun cron engine (taker-bot) keeps demo volume flowing on a schedule; positions stay manageable from the dashboard.

## Repo map

| Path         | What                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `web/`       | Next.js dashboard + API (positions, deploy pipeline, delegation, decisions history) |
| `taker-bot/` | Autonomous taker service filling our own strategies (demo volume engine)     |

## Run it

```bash
git clone <repo-url> aquara && cd aquara
bun install
cp web/.env.example web/.env         # 1inch key + RPC + relayer key (server-only)
cp taker-bot/.env.example taker-bot/.env
docker compose -f web/docker-compose.yml up -d   # postgres
bunx --cwd web prisma migrate deploy
bun run dev:web                      # dashboard on :3000 (Base mainnet, real funds!)
```

Full walkthroughs in
[`web/README.md`](web/README.md) and [`taker-bot/README.md`](taker-bot/README.md).
