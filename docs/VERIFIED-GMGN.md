# VERIFIED: GMGN data layer for Robinhood chain (tested live, main session)

Source: github.com/GMGNAI/gmgn-skills — official CLI. Installed globally (`gmgn-cli`, PATH /opt/homebrew/bin).
User's personal API key configured at `~/.config/gmgn/.env` (chmod 600). NEVER copy the key value into docs.
Chain `robinhood` officially supported: token / market / portfolio / track / swap / order / gas-price.
NOT supported on robinhood: kol/smartmoney track, signal, cooking.

## Tested working (robinhood chain)
- `gmgn-cli market trending --chain robinhood --interval 1m|5m|1h|6h|24h --limit N --raw`
  Rich rows: price, price_change 1m/5m/1h, volume, liquidity, market_cap, holder_count,
  top_10_holder_rate, smart_degen_count, renowned_count, rat_trader_amount_rate, bundler_rate,
  sniper_count, rug_ratio (0-1), is_honeypot, is_wash_trading, bot_degen_rate, launchpad,
  open_timestamp. Filters: --min-liquidity, --min-smart-degen-count, --max-created, etc.
  => THE RADAR FEED.
- `gmgn-cli market kline --chain robinhood --address <t> --resolution 30s|1m|5m|15m|1h|4h|1d --from <unix> --to <unix> --raw`
  OHLCV + volume. TRUE INTRADAY CANDLES => compute real σ from 5m/1h candle ranges
  (better than Meteora's daily-candle limitation; drop the ×17 scaling hacks).
- `gmgn-cli token security --chain robinhood --address <t> --raw`
  honeypot, renounced, open_source, blacklist, buy/sell tax, top10 rate. => HARD rug gates.
- `gmgn-cli token pool --chain robinhood --address <t> --raw`
  Returns "exchange":"uniswap_v3" + the actual Uniswap pool_address + quote token (WETH)
  + liquidity + reserves + creation ts. => THE GMGN→UNISWAP BRIDGE (radar chip deep-links
  to the right pool).
- `gmgn-cli token info|holders|traders`, `gmgn-cli portfolio holdings --chain robinhood --wallet <addr>`
  (holdings = token balances, NOT LP positions — LP position reads still unsolved).

## Flow-quality analog (replaces Jupiter OFI/organic score)
Per token from trending/info: smart_degen_count, renowned_count, rat_trader_amount_rate,
bundler_rate, sniper_count, bot_degen_rate, rug_ratio. Design a composite "flow quality"
metric from these.

## Remaining unknowns (fork: focus here)
1. LP position reads by wallet (Uniswap v3 NFTs) on robinhood chain — subgraph? LP API? RPC to
   NonfungiblePositionManager (address?).
2. Pool fee tier (500/3000/10000) + pool-level 24h volume source (GMGN volume is token-level).
3. app.uniswap.org add-liquidity DOM anchors (range inputs, fee tier selector) + deep-link format
   for robinhood chain.
4. Uniswap LP API base URL + auth (user pasted docs: /approve /create /increase /decrease /claim).
