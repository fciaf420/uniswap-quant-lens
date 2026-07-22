# Uniswap Quant Lens (Robinhood Chain) — Research Findings
Verified live 2026-07-21 by forked worker. All claims below were tested unless marked TBD.

## 1. GMGN (discovery layer) — WORKS, same-origin only
- Trend page for robinhood loads clean (no Cloudflare block in a real browser session).
- **DOM**: table-based; columns observed per row: Token/Age, MC, ATH MC, price + 5m/1h/24h change windows, holders, txs (buys/sells), volume, liq (ETH), Top10 %, insider/sniper %, dev flags, security chips ("NoHoneypot / Verified / Renounced / Locked"). Sample row parsed cleanly from `tbody tr` textContent. 33 rows rendered.
- **API (the big win)**: `GET /defi/quotation/v1/rank/robinhood/swaps/1h?orderby=swaps&direction=desc` returns **200 + full JSON** when fetched **from the page context** (same-origin, rides the user's CF cookies). Payload: `data.rank[]` with `address, name, symbol, price, price_change_percent, ...` (volume/holders fields present in the full payload).
  - From plain node/fetch (no cookies) GMGN endpoints are Cloudflare-gated → **the extension's GMGN radar must fetch from the content script on gmgn.ai**, not from the background worker.
  - Other observed endpoint families: `/api/v1/gas_price_list`, `/api/v1/major_coin_prices`, `/tapi/v1/wallet/list?chain=robinhood`, `/td/api/v1/wallets/holdings?chain=robinhood&wallet_addresses=0x...` (GMGN tracks an 0x wallet for the user already).

## 2. Pool/market data — GeckoTerminal WORKS, no auth
- `GET https://api.geckoterminal.com/api/v2/networks` → network id **`robinhood` exists** (page 3).
- `GET /networks/robinhood/pools?sort=h24_volume_usd_desc` → 20 pools with `reserve_in_usd` (TVL), `volume_usd.h24`, `price_change_percentage`, dex relationship. **Verified sample:**
  - USDG/WETH 0.01% — uniswap-v3-robinhood — TVL $4.07M, vol24 $89.4M
  - HRX/WETH 0.3% — **uniswap-v4-robinhood** — TVL $204k, vol24 $11.2M
  - REAL/WETH — uniswap-v2-robinhood; plus dyorswap pools
  - **Fee tier is embedded in the pool NAME string** (e.g. "0.3%") for v3/v4 — parse from name.
- `GET /networks/robinhood/pools/{addr}/ohlcv/hour?limit=N` → **hourly OHLCV works** (tested, real candles). Day/minute resolutions available per GT docs.
- Rate limit: free tier ~30 calls/min (hit a 429 during testing). Extension must cache + budget calls.

## 3. Uniswap deployments + execution paths
- **v2, v3 AND v4 all deployed on Robinhood Chain** (from GT dex ids: `uniswap-v2/-v3/-v4-robinhood`).
- **Uniswap LP API** (`/approve /create /increase /decrease /claim /migrate`): base `https://api.uniswap.org/...` responds `409 ACCESS_DENIED` without credentials → **requires an API key** (Uniswap developer hub registration). Viable later; not needed for a lens-style extension (the Uniswap web app builds the txs; Rabby signs).
- **app.uniswap.org**: supports robinhood chain (`/positions/create?chain=robinhood` loads). Uses **`data-testid` attributes throughout** (stable anchors, like Meteora's data-sentry). NOTE: the create-position form's range inputs only render after wallet connect + pair selection — full DOM recon of range inputs deferred to build phase (needs the user's connected Rabby).

## 4. Robinhood Chain basics
- EVM chain (0x addresses), quote asset in practice = **WETH** (all top pools are X/WETH) → native gas ETH. User signs with **Rabby** (installed).
- Chain id / RPC / explorer: **TBD** — verify via chainlist/official docs at build time (not needed for design).

## Feasibility risks (ranked)
1. **GMGN same-origin constraint**: radar data only fetchable while a gmgn.ai tab exists (content script). Background-worker alerts can't use GMGN directly → alerts must run off GeckoTerminal instead, or require a pinned gmgn tab.
2. **GT rate limits** (~30/min): cache aggressively; scan top ~10 pools only.
3. **No surge signal**: v3 fees are static tiers; the dynamic-fee "premium elevated" gate has no analog (v4 hooks could, later). Ignition-style timing must lean on volume-accel + σ only.
4. **Uniswap form fill**: range inputs unverified until wallet-connected recon; worst case the Apply button falls back to "copy suggested min/max prices" UX.
5. Robinhood chain is young: thin pool set (~20 liquid), data may be sparse/noisy.
