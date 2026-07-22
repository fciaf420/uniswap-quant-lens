# Uniswap Quant Lens (Robinhood Chain)

A read-only Chrome extension (Manifest V3) that overlays quant signals for LPing
on **Uniswap (Robinhood Chain)**, using **GMGN** as the discovery layer and
**GeckoTerminal** (network id `robinhood`) as the market-data source.

It surfaces the fee / volatility / edge math the stock UIs hide, and warns you
about range and fee-decay foot-guns.

**It never signs transactions and never touches your keys.** Pure lens +
warnings — Rabby signs everything, you click every money button.

## Surfaces

- **GMGN radar overlay** (`gmgn.ai`) — injects EDGE / σ / FlowScore / verdict
  chips into the trend table and a floating radar bar, with deep links to the
  Uniswap create-position page. *(Agent B: `content-gmgn.js`)*
- **Uniswap HUD** (`app.uniswap.org`) — a card with edge, fee run-rate, σ, path,
  and a breakeven strip near the range selector. *(Agent B: `content-uniswap.js`)*
- **Position Watch** (background) — pinned positions are polled every minute for
  out-of-range / TP / SL / fee-decay and alerted to Discord + desktop.

## Install (Load Unpacked)

1. Download this folder (`ext/`).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `ext/` folder.
5. Open `https://gmgn.ai` (Robinhood trend) to discover, and
   `https://app.uniswap.org` when building a position.

## Configure

Open the extension **Options** (`chrome://extensions` → *Details* → *Extension
options*):

- **Discord webhook URL** — for remote alerts. In Discord: *Channel → ⚙ Edit
  Channel → Integrations → Webhooks → New Webhook → Copy URL*. The mobile app
  pushes these to your phone. Use **Send test alert** to verify.
- **Default range width W (%)** — used for the edge / breakeven math. Default
  `20`.
- **🔥 radar-signal ping** — when the GMGN content script reports a FULL signal,
  ping Discord (2h cooldown per token). Requires the webhook.
- **Pinned positions** — add a position by token address. The background worker
  resolves the highest-TVL Uniswap pool and snapshots the entry price + entry
  fee-rate. If you leave Min/Max blank they default to ±(recommended width)
  around entry.

GeckoTerminal needs no auth. There is **no** on-chain key or wallet here.

## What each signal means

- **EDGE** — fee income vs IL-breakeven for the token's best Uniswap pool.
  `≥1` green (fees beat expected IL), `0.5–1` yellow, `<0.5` red.
  `edge = (feeRate·0.9/σ) ÷ (1.3·σ/(8·W))`, W = your default width.
- **feeRate** — `vol24h × feeTier ÷ TVL × 100` (%/day). The fee tier is parsed
  from the pool name (e.g. "0.3%"); Uniswap v2 pools default to 0.3%. A finer
  **run-rate** (`feeRateRun`) is also computed from the last 1–4 hourly candle
  volumes when available.
- **σ (sigma)** — realized volatility in %/day: the stddev of hourly log-returns
  over the last 24 candles, `× √24 × 100`. Real candles, no scaling hacks.
- **path** — price structure: `FREEFALL`, `BASING`, `BLOWOFF`, `GRIND-UP`,
  `CHOP`. *Approximation:* GeckoTerminal gives hourly candles only, so the
  "1h change" uses the last single candle, the "24h change" uses the last 24
  candles, and the fast (5m-equivalent) change is approximated by the last
  hourly candle. Hourly is the resolution floor.
- **brackets** — `TP = clamp(W/4 + feeRate·0.5, 8, 25)`,
  `SL = −clamp(0.75·W + 2, 8, 20)`, where `widthPct` is the σ-derived
  recommended position width `clamp(round(σ/4), 12, 30)`.

## Message contract (for the content scripts)

The content scripts talk to the background service worker:

- `{ type: "getTokenMetrics", tokenAddress }` →
  `{ ok, pool:{address,name,feeTierPct,tvl,vol24}, feeRate, sigma, edge, path,
     ddHigh, brackets:{tp,sl,widthPct}, ts }`. Chooses the highest-TVL Uniswap
  pool; on failure returns `{ ok:false, error, ...null fields }`.
- `{ type: "getBreakeven", tokenAddress, widthPct }` →
  `{ ok, breakevenFeePerDay, poolFeePerDay, clears }`.
- `{ type: "notify", title, message }` → desktop notification.
- `{ type: "testWebhook" }` → posts a test to the saved Discord webhook.
- `{ type: "radarSignal", item }` → GMGN reported a FULL signal (2h-deduped
  Discord ping when the radar toggle is on).

### Guardrails / caching

- All GeckoTerminal responses are cached **120s** per resource.
- A **global rate limiter** caps requests at **≤20/min** with a serialized queue
  and **exponential backoff on 429** (GeckoTerminal 429s at ~30/min).
- All fetches use an **8s AbortController** timeout; everything is wrapped in
  try/catch and degrades to `{ ok:false, error }` — the message boundary never
  throws.

## Disclaimer

For informational purposes only — **not** financial advice. Signals are
heuristics from public GMGN / GeckoTerminal data and can be wrong, stale, or
incomplete.

**No custody, no auto-signing.** Rabby is the only thing that signs; you click
every money button. Robinhood-chain memecoins are rug-grade — **the model prices
volatility, not rugs.** A young token can pass every quant gate and still be an
exit-scam. Size every position for total loss.
