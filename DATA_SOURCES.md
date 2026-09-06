# Aqua Data Sources — Temuan untuk AI Manager

> Catatan riset 2026-09-05 untuk hackathon 10 hari. Semua endpoint butuh `1inch API key` header `Authorization: Bearer <key>`.

## 1. Core Concept Aqua (penting buat Calibur)
- Self-custodial: token tetap di wallet, cuma `allowance` ke `Aqua 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` (sama di 13 chain).
- Virtual balance: `balances[maker][app][strategyHash][token]` counter on-chain, bukan token transfer.
- Lifecycle: `ship(app, strategyBytes, tokens[], amounts[])` -> `strategyHash=keccak(strategy)` immutable. `dock(app, strategyHash, tokens[])` cabut. `pull/push` cuma dipanggil AquaApp pas swap atomik.
- Fee auto-compound: `push()` langsung nambah virtual balance, gak perlu claim.
- Router: `AquaSwapVMRouter v1.0.2 0x111111338c5091e8440b67b168bae16a668ac0de` eksekusi SwapVM program.

## 2. Data Penting & Cara Dapetin

### A. List & Discovery
- `GET https://api.1inch.com/aqua/v1.0/strategies/opened?chainIds=1,8453&limit=100`
  - Return semua strategy open terbaru, `strategyHash, strategyBytes, maker, app, tokens[{address, balance.strategy/wallet, allowance}]`
  - Pagination `nextCursor`.
- `GET /v1.0/strategies/makers/{maker}` -> semua strategy milik user (open+closed) + `performance`.

### B. Performance / Pool Rame (untuk rekomendasi AI)
- `GET /v1.0/strategies/overview/{chainId}/{maker}/{app}/{strategyHash}`
  - `performance.fees: {total, last24h, last7d, last30d} {usd, apy}`
  - `performance.volume: {usd}`
  - `classification: {type: concentrated|xyC|pegged, state: active|inactive, feePercent}`
  - `priceRange: {min, max, minUsd, maxUsd}`
  - `tokens[]: {initialBalance, currentBalance, wallet.balance/allowance}`
  - `status: open/closed`, `openedAt`
- `GET /v1.0/strategies/volume/{chainId}/{maker}/{app}/{strategyHash}?granularity=1d`
  - Time-bucketed USD incoming volume per strategy. Bucket UTC, `usd` per hari.
  - Untuk rank "pool paling rame" -> aggregate `volume.last7d` dari `opened` + sort.
- `GET /v1.0/strategies/makers/{address}/stats`
  - Aggregated: `liquidity.shared/pullable/wallet (usd)`, `strategies.open/active`, `performance.fees/volume` semua chain.

### C. OOR Detection (untuk rebalance)
- Dari `overview`: kalau `tokens[0].currentBalance.raw == 0` atau `tokens[1].raw == 0` -> OOR 1 sisi.
- Atau `classification.state != active` atau `priceRange` vs `openingPrice` jauh.
- On-chain fallback: `Aqua.rawBalances(maker, app, strategyHash, token)` view.

### D. Campaign / Rewards
- Sumber: Merkl, bukan Aqua API. `5M 1INCH volume rewards + 5M partner co-incentives + 500k USDC` 3 bulan via Merkl.
- Eligible markets: 80+ `1INCH/*` pairs, pro-rata volume, recalc 8 jam sekali.
- API: `Merkl API https://api.merkl.xyz` atau `https://api.1inch.com/aqua` tidak ada reward field. Fetch `Merkl campaigns where chain + tokenIn=1INCH`.
- Leaderboard: `1inch.com/aqua incentives page` + `app.merkl.xyz`.

### E. On-chain Events (jika API limit / butuh real-time)
- 5 events keyed `(maker, app, strategyHash)`: `Shipped, Docked, Pulled, Pushed` dari `AquaRouter`, `Swapped` dari `SwapVMRouter`.
- `strategyHash = keccak256(strategyBytes)` (bukan `abi.encode`).
- The Graph: **TIDAK ada hosted subgraph resmi**. Harus self-index `eth_getLogs` dari `creationBlock` registry (beda per chain, jangan pakai router block). Komunitas `sluice/aqua` subgraph cuma Base/Ethereum.

### F. Swap untuk Rebalancing
- Kalau perlu ganti token (USDC -> WETH) pakai `1inch Swap API / Fusion` (sama kayak ALMA pakai Trading API).
- Quote dulu baru `ship` ulang.

## 3. Catatan Hackathon
- ALMA pakai `Uniswap Trading API + Calibur`, di Aqua pakai `Aqua API + Merkl API + 1inch Swap API`.
- Virtual balance tidak perlu `approve` ulang ke Aqua kalau allowance masih `max`.
- Strategy immutable: rebalance = `dock(old) + ship(new)` dalam 1 Calibur batch `SignedBatchedCall`.
- Contract addresses sabit di `13 chain`: lihat `supportedChains = [1,10,56,100,130,137,146,324,4663,8453,42161,43114,59144]`.
