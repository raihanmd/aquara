# Aquara Web — dashboard + agent backend

The user-facing half of Aquara: see your 1inch Aqua positions truthfully,
deploy capital in one click, and authorize a scoped agent key that does the
rest. Next.js on Base mainnet.

## Tour

- **Header**: slippage control (agent swaps), global refresh (invalidates all
  queries), connect button.
- **Your Aqua Positions**: one card per strategy. Badges tell the truth:
  `In Range` / `Out of Range` / `Illiquid`,
  `Aggressive` (AI-managed) vs default Stable, set-range,
  per-token coverage, earned PnL, BaseScan + 1inch overview links, hover-to-Close.
- **Top Positions**: leaderboard to copy strategies from.
- **Deploy strategy** (needs delegation): capital with live balances, top positions copy
  or manual pairs, Stable/Aggressive toggle.
- **Agent pass modal**: one signature authorizes the agent for 30 days
  (EIP-712 key registration + hook whitelist + expiry, and relayed).

## Under the hood

- **Allocator** (`app/api/agent/deploy`): inventory (wallet − allocated per
  token) → equal-USD budgets → cover from unallocated first, swap shortfalls
  → range ±10% from verified price feed → build order (salted, taker fee) →
  **simulate every call pre-flight** → execute adaptively with partial-report
  stops. Nothing submits unless simulation passes.
- **Detection** (`hooks/use-delegation`): version-agnostic Calibur (any
  implementation), on-chain EIP-712 domain discovery, Base-pinned reads.
- **API** (`app/api/...`): positions (uncached, always live), tokens, top,
  strategies/modes, settings, agent jobs/decisions, delegate relay.
- **DB** (Postgres/Prisma): delegations, jobs, decisions, strategies+modes+ranges.

## Run

```bash
bun install
docker compose up -d
cp .env.example .env   # server keys stay server-side (see file comments)
bunx prisma migrate dev
bun dev
```
