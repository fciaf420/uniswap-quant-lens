# Uniswap Quant Lens (Robinhood Chain) — MV3 Chrome Extension Spec v0.1-draft
Ports the Meteora Quant Lens architecture (see ../meteora-lens/SPEC.md) to Uniswap v2/v3/v4 on Robinhood Chain, with GMGN as discovery. Lens + warnings only: NO key custody, NO auto-signing — Rabby signs everything, the user clicks every money button.

## Concept mapping (Meteora → Uniswap/Robinhood)
| Meteora Lens concept | Uniswap/Robinhood analog | Transfers? |
|---|---|---|
| edge = netFee/day ÷ (1.3·σ/(8W)) | identical math; W = % half-width of tick range | ✅ unchanged |
| feeRate (fee_tvl 1h×24) | volume24h × feeTier ÷ TVL (GT data; feeTier parsed from pool name) — plus finer run-rate from hourly OHLCV volume × feeTier ÷ TVL | ✅ computable |
| σ (Jupiter multi-window) | GT hourly OHLCV → realized vol (√t-scaled hourly returns); 24h window from candles | ✅ (different source) |
| surge (dynamic-fee accumulator) | ❌ NO ANALOG on v3 (static tiers). v4 hooks may vary fees — phase 2 investigation. Ignition gate becomes edge + accel only, with tighter accel bar (≥1.5) to compensate | ⚠️ signal lost |
| OFI (Jupiter organic flow) | GMGN per-token: buys/sells counts, smart-money activity, insider %, Top10 %, sniper flags. Define **FlowScore** = sells/buys (1h) + red flags weighting | ✅ (richer in some ways) |
| path labels (OHLCV) | same formulas from GT candles (FREEFALL/BASING/BLOWOFF/GRIND-UP/CHOP) | ✅ |
| token safety (mint/freeze) | GMGN security chips: Honeypot / Verified / Renounced / LP Locked + Top10% | ✅ (EVM-flavored) |
| bin step / bins | tick spacing per fee tier; UI works in % prices — Lens stays in %, Uniswap form converts | ✅ |
| Zap In/Out | no native zap on the Uniswap form (v3: two-sided requires both tokens; app offers swap-and-add in some flows) — note friction | ⚠️ |

## Surfaces
### A. GMGN Radar overlay (content script on gmgn.ai) — THE MVP CORE
- Same-origin fetch `/defi/quotation/v1/rank/robinhood/swaps/{1h}` (verified working) + GT pool lookups (background) to join token → its Uniswap pool(s).
- Injects score badges directly into the trend table rows: EDGE pill (fees vs IL-breakeven for that token's best Uniswap pool), σ, FlowScore, verdict chip.
- Floating radar bar (like Meteora's) listing 🔥 full signals; chips deep-link to `app.uniswap.org/positions/create?chain=robinhood&currencyA=<token>&currencyB=WETH` (verify param names at build).
- Constraint: runs only while a gmgn tab is open (CF same-origin) — acceptable: this IS the discovery workflow.

### B. Uniswap HUD (content script on app.uniswap.org)
- On pool/position/create pages for robinhood chain: HUD card with edge, feeRate run-rate (GT), σ, path, FlowScore (via background↔GMGN-tab relay if a gmgn tab is open; else omit), verdict + recipe (width from σ/4 clamp 12-30; brackets TP = W/4 + fees×0.5d clamp 8-25, SL = −(0.75W+2) clamp 8-20 — the corrected earnable-PnL math).
- **Breakeven strip** near the range selector: "±W% needs ≥X%/day — this pool pays Y%/day ✓/✗" recomputed as the user edits min/max (anchors: data-testid; exact ids TBD after wallet-connected recon).
- Apply-style fill: phase 2 (form anchors unverified). Phase-1 fallback: recipe card shows copyable min/max prices.

### C. Position Watch + alerts (background worker)
- User saves wallet address (0x, Rabby) in options. Background polls GT pool prices + reads positions:
  - v3 positions: NonfungiblePositionManager balanceOf/tokenOfOwner/positions() via public RPC (chain RPC TBD) — or phase 2 via Uniswap API key.
  - Simpler MVP: user pins positions manually (pool addr + range + entry) in options; watcher computes in/out-of-range, feeRate decay vs entry, path — Discord webhook alerts identical to Meteora Lens (OOR / TP / SL / FEE-DECAY / FLOW via GMGN when available).
- Reuses the exact alert framework: transitions, 2h dedup, journaling to storage.

## Verdict classes (adapted)
- IGNITION (scalp): edge ≥1 AND accel ≥1.5 (no surge exists) AND FlowScore clean AND path ≠ FREEFALL AND security chips green.
- BASING: same formulas from GT candles; fees ≥15%/day; stop below day low.
- CARRY: edge ≥1.3, tokenAge ≥72h, Renounced + LP-Locked required, TVL ≥ $250k (thin chain → higher floor), ±35%.
- SQUEEZE: phase 2 (needs σ history layer, mint-keyed — port from Meteora).

## MVP cut
**Phase 1 (ship first):** GMGN radar overlay with edge/σ/flow scoring + verdict chips + deep links; Uniswap HUD with breakeven strip (read-only math); options (GT budgeting, Discord webhook, wallet/pinned positions); Discord alerts for pinned positions.
**Phase 2:** Apply-fill on the Uniswap range form (post wallet-connected DOM recon); on-chain position auto-discovery via RPC; σ-history + SQUEEZE; v4 hook-fee awareness; Uniswap LP API key integration for one-click tx building.

## Guardrails (unchanged from Meteora Lens)
No custody, no auto-sign, Rabby is the only trigger; all thresholds are priors-on-notice pending trade-log calibration; young-token banner: "model prices volatility, not rugs — size for total loss" (Robinhood chain memecoins are rug-grade).
