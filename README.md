# Aquara — AI Liquidity Manager for 1inch Aqua

Small capital earns nothing on-chain: aggregators route around it, and manual
range management is a full-time job. **Aquara turns any wallet into a managed
liquidity position**: delegate once to a scoped agent key, deploy capital into
1inch Aqua strategies in one click, and let automation keep the capital productive.

Live on **Base mainnet** (chain 8453), built on **1inch Aqua** + **Chainlink CRE** + **Calibur**
(EIP-7702 smart wallets).

## 3-minute demo

1. **Connect + Delegate** — open the dashboard, click _Delegate to agent_,
   sign once. Your EOA first need to becomes a Calibur smart wallet, then let delegated to our agent, the agent key may only
   touch an explicit whitelist (Aqua ship/dock, token approvals, 1inch router).
   Revoke anytime, key auto-expires in 30 days.
2. **Deploy** — pick a pair (e.g. USDC/WETH), choose Stable or Aggressive,
   Deploy. Watch live progress: planning → swaps → ship → on-chain position.
3. **See it work** — the position card shows live badges (In Range, Fillable,
   range, earned).
   (DEV AND DEMO ONLY) Run the taker bot once: it fills your own position, volume
   and taker fees accrue on the card within minutes.

## How it fits together

```
wallet (Calibur 7702) ── scoped key ──▶ agent relayer ──▶ Aqua (ship/dock/pull/push)
```

- No custody: tokens never leave your wallet (Aqua allowance model).
- Every number on screen traces to chain or the 1inch API.

## Repo map

| Path         | What                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `web/`       | Next.js dashboard + API (positions, deploy pipeline, delegation, agent tick) |
| `taker-bot/` | Autonomous taker service filling our own strategies (demo volume engine)     |
| `contracts/` | _(planned)_ AquaHook for Calibur + Foundry scripts                           |
| `cre/`       | _(planned)_ Chainlink CRE auto-manage                                        |

## Run it

```bash
bun install
cp web/.env.example web/.env         # 1inch key + RPC + relayer key (server-only)
cp taker-bot/.env.example taker-bot/.env

# Fill guide also in .env.example

bun run dev:web                      # dashboard on :3000 (Base mainnet, real funds!)
```

Full walkthroughs in
[`web/README.md`](web/README.md) and [`taker-bot/README.md`](taker-bot/README.md).
