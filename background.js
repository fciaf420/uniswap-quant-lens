/* Uniswap Quant Lens — background service worker (MV3)
 * Data fetching (GeckoTerminal, network "robinhood") + ALL math + message
 * handling + pinned-position watcher/alerts.
 *
 * Vanilla JS, no imports/modules. Everything defensive; never throw across the
 * message boundary — always sendResponse({ok:false,error}) on failure.
 *
 * Ported from the Meteora Quant Lens background worker (../meteora-lens):
 * same caching / rate-limit / alert-framework / Discord-webhook patterns.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GT = 'https://api.geckoterminal.com/api/v2';
const NET = 'robinhood';
const CACHE_TTL_MS = 120 * 1000;     // 120s per-resource cache (spec HARD RULE)
const FETCH_TIMEOUT_MS = 8000;       // AbortController budget per request
const RL_MAX = 20;                   // <=20 req/min (GT 429s at ~30/min)
const RL_WIN_MS = 60 * 1000;
const RL_BACKOFF_START_MS = 1000;    // exponential backoff base on 429
const RL_MAX_RETRIES = 3;
const DEDUP_MS = 2 * 60 * 60 * 1000; // 2h alert dedup
const ICON = 'icon128.png';

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v, dflt = 0) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return (typeof n === 'number' && isFinite(n)) ? n : dflt;
}

function clampN(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fmt2(v) {
  return (v == null || isNaN(v)) ? '—' : (Math.round(v * 100) / 100).toString();
}

// pick first defined value across candidate keys / dotted paths
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (k == null) continue;
    if (k.indexOf('.') >= 0) {
      let cur = obj, ok = true;
      for (const part of k.split('.')) {
        if (cur == null || typeof cur !== 'object') { ok = false; break; }
        cur = cur[part];
      }
      if (ok && cur !== undefined && cur !== null) return cur;
    } else if (obj[k] !== undefined && obj[k] !== null) {
      return obj[k];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Global rate limiter: serialized queue, <=RL_MAX per rolling RL_WIN_MS
// ---------------------------------------------------------------------------

const rlTimes = [];
let rlChain = Promise.resolve();

function rlSlot() {
  const p = rlChain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (rlTimes.length && (now - rlTimes[0]) >= RL_WIN_MS) rlTimes.shift();
      if (rlTimes.length < RL_MAX) { rlTimes.push(now); return; }
      const wait = RL_WIN_MS - (now - rlTimes[0]) + 50;
      await sleep(wait > 0 ? wait : 50);
    }
  });
  rlChain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------------------
// Cached, rate-limited, backoff-aware GeckoTerminal fetch
// ---------------------------------------------------------------------------

const gtCache = new Map(); // url -> { ts, data }

async function gtFetch(url) {
  const cached = gtCache.get(url);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

  let attempt = 0;
  let backoff = RL_BACKOFF_START_MS;
  for (;;) {
    await rlSlot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.status === 429) {
        attempt++;
        if (attempt > RL_MAX_RETRIES) return { ok: false, status: 429, error: 'rate limited (429)' };
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: 'HTTP ' + res.status + ' for ' + url };
      }
      const json = await res.json();
      const out = { ok: true, json };
      gtCache.set(url, { ts: Date.now(), data: out });
      return out;
    } catch (e) {
      clearTimeout(timer);
      attempt++;
      if (attempt > RL_MAX_RETRIES) return { ok: false, error: (e && e.message) ? e.message : String(e) };
      await sleep(backoff);
      backoff *= 2;
    }
  }
}

// ---------------------------------------------------------------------------
// GeckoTerminal client
// ---------------------------------------------------------------------------

// Parse a pool descriptor object out of a GT pool `data` element.
function poolFromGT(el) {
  if (!el || !el.attributes) return null;
  const a = el.attributes;
  const dexId = pick(el, 'relationships.dex.data.id') || '';
  const name = a.name || '';
  return {
    address: a.address || (String(el.id || '').split('_').pop()) || '',
    name,
    dexId,
    // Prefer GT's explicit pool_fee_percentage field (live-verified on robinhood);
    // fall back to parsing the "... 0.3%" suffix in the pool name.
    feeTierPct: (a.pool_fee_percentage != null && isFinite(parseFloat(a.pool_fee_percentage)))
      ? parseFloat(a.pool_fee_percentage)
      : parseFeeTier(name),
    tvl: num(a.reserve_in_usd, 0),
    vol24: num(pick(a, 'volume_usd.h24'), 0),
    vol5m: num(pick(a, 'volume_usd.m5'), 0),
    createdAt: a.pool_created_at || null,
    priceUsd: num(a.base_token_price_usd, 0),
    isUniswap: /uniswap/i.test(dexId)
  };
}

// Fee tier is embedded in the pool NAME string, e.g. "USDG / WETH 0.01%".
// Uniswap v2 pools have no % in the name -> default to 0.3%.
function parseFeeTier(name) {
  if (!name) return null;
  const m = String(name).match(/([\d.]+)\s*%/);
  if (m) {
    const v = parseFloat(m[1]);
    if (isFinite(v)) return v;
  }
  return null;
}

// Get all pools for a token, keep only Uniswap pools, sorted by TVL desc.
async function fetchTokenPools(tokenAddress) {
  const url = GT + '/networks/' + NET + '/tokens/' + encodeURIComponent(tokenAddress) + '/pools';
  const resp = await gtFetch(url);
  if (!resp.ok) return { ok: false, error: resp.error || ('status ' + resp.status) };
  const data = (resp.json && Array.isArray(resp.json.data)) ? resp.json.data : [];
  const pools = data.map(poolFromGT).filter((p) => p && p.address);
  const uni = pools.filter((p) => p.isUniswap);
  uni.sort((a, b) => b.tvl - a.tvl);
  return { ok: true, pools, uni };
}

// Pool detail by pool address (fallback / watcher path).
async function fetchPoolDetail(poolAddress) {
  const url = GT + '/networks/' + NET + '/pools/' + encodeURIComponent(poolAddress);
  const resp = await gtFetch(url);
  if (!resp.ok) return { ok: false, error: resp.error || ('status ' + resp.status) };
  const p = poolFromGT(resp.json && resp.json.data);
  if (!p) return { ok: false, error: 'no pool detail' };
  return { ok: true, pool: p };
}

// Hourly OHLCV candles (ascending by timestamp).
async function fetchOhlcvHour(poolAddress, limit) {
  const lim = num(limit, 25) || 25;
  const url = GT + '/networks/' + NET + '/pools/' + encodeURIComponent(poolAddress)
    + '/ohlcv/hour?limit=' + lim + '&aggregate=1';
  const resp = await gtFetch(url);
  if (!resp.ok) return { ok: false, error: resp.error || ('status ' + resp.status) };
  const list = pick(resp.json, 'data.attributes.ohlcv_list');
  if (!Array.isArray(list)) return { ok: true, candles: [] };
  const candles = list.map((r) => ({
    t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5])
  })).filter((c) => isFinite(c.c) && c.c > 0);
  candles.sort((a, b) => a.t - b.t);
  return { ok: true, candles };
}

// ---------------------------------------------------------------------------
// MATH  (ported from Meteora Lens; adapted to GT hourly candles)
// ---------------------------------------------------------------------------

// σ %/day from hourly OHLCV: stddev of ln(close/prevClose) over last 24 candles
// × sqrt(24) × 100. Real candles — no scaling hacks. Population stddev.
function computeSigma(closes) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const c = closes.slice(-25); // up to 25 closes -> up to 24 log returns
  const rets = [];
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1], b = c[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const varr = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / rets.length;
  return Math.sqrt(varr) * Math.sqrt(24) * 100;
}

// edge = (feeRate*0.9/σ) / (1.3*σ/(8*W))   with W in percent (default 20)
function computeEdge(feeRate, sigma, W) {
  const s = Math.max(num(sigma), 0.001);
  const numer = num(feeRate) * 0.9 / s;
  const denom = Math.max(1.3 * num(sigma) / (8 * W), 0.001);
  return numer / denom;
}

// breakevenFeePerDay = σ²/(8*W)/0.9
function computeBreakeven(sigma, W) {
  const s = num(sigma);
  return (s * s) / (8 * W) / 0.9;
}

// Recommended position width from σ: clamp(round(σ/4), 12, 30). Default 20 if σ null.
function recWidth(sigma) {
  if (sigma == null || !isFinite(sigma)) return 20;
  return Math.round(clampN(sigma / 4, 12, 30));
}

// Brackets scaled to the recommended width W and current fee rate.
// TP = clamp(W/4 + feeRate*0.5, 8, 25) ; SL = -clamp(0.75*W+2, 8, 20)
function computeBrackets(W, feeRate) {
  const tp = Math.round(clampN(W / 4 + num(feeRate) * 0.5, 8, 25));
  const sl = -Math.round(clampN(0.75 * W + 2, 8, 20));
  return { tp, sl, widthPct: W };
}

// Path classification (same formulas as Meteora Lens).
function computePath(pc5, pc1, ddHigh, rangePos) {
  const p5 = num(pc5), p1 = num(pc1);
  if (p1 <= -25 || (p5 <= -8 && p1 < 0)) return 'FREEFALL';
  if (num(ddHigh) >= 40 && Math.abs(p5) < 5 && p1 > -15) return 'BASING';
  if (num(rangePos) > 0.85 && p1 > 40) return 'BLOWOFF';
  if (p1 > 0) return 'GRIND-UP';
  return 'CHOP';
}

// Derive candle-based signals.
// APPROXIMATIONS (documented): we only have hourly candles, so
//   pc1h  = last single-candle % change (close vs prev close)
//   pc24  = change over the last 24 candles (~24h)
//   pc5m-equivalent = pc1h (no sub-hour data on GT hourly; hourly is our floor)
function candleSignals(candles, feeTierFrac, tvl, vol24) {
  const closes = candles.map((c) => c.c);
  const sigma = computeSigma(closes);

  const n = candles.length;
  const lastC = n ? candles[n - 1].c : 0;
  const prevC = n >= 2 ? candles[n - 2].c : lastC;
  const pc1 = prevC > 0 ? (lastC - prevC) / prevC * 100 : 0;
  const pc5 = pc1; // pc5m-equivalent approximation
  const ref24 = n >= 25 ? candles[n - 25].c : (n ? candles[0].c : 0);
  const pc24 = ref24 > 0 ? (lastC - ref24) / ref24 * 100 : 0;

  const last24 = candles.slice(-24);
  let high24 = 0, low24 = Infinity;
  for (const c of last24) { if (c.h > high24) high24 = c.h; if (c.l < low24) low24 = c.l; }
  if (!isFinite(low24)) low24 = 0;
  const ddHigh = high24 > 0 ? (high24 - lastC) / high24 * 100 : 0;
  const rangePos = (high24 - low24) > 0 ? (lastC - low24) / (high24 - low24) : 0.5;

  const path = (sigma == null && n < 2) ? null : computePath(pc5, pc1, ddHigh, rangePos);

  // finer fee run-rate from last 1-4 hourly candle volumes (when available)
  let feeRateRun = null;
  const recent = candles.slice(-4).map((c) => c.v).filter((v) => v > 0);
  if (recent.length && tvl > 0 && feeTierFrac != null) {
    const avgHourly = recent.reduce((s, x) => s + x, 0) / recent.length;
    feeRateRun = avgHourly * 24 * feeTierFrac / tvl * 100;
  }

  return { sigma, pc1, pc5, pc24, ddHigh, rangePos, path, feeRateRun, lastC, high24, low24 };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(
        { webhookUrl: '', uqlWidthPct: 20, radarAlerts: false, pinnedPositions: [] },
        (items) => {
          const it = (chrome.runtime.lastError || !items) ? {} : items;
          resolve({
            webhookUrl: it.webhookUrl ? String(it.webhookUrl) : '',
            uqlWidthPct: num(it.uqlWidthPct, 20) || 20,
            radarAlerts: !!it.radarAlerts,
            pinnedPositions: Array.isArray(it.pinnedPositions) ? it.pinnedPositions : []
          });
        }
      );
    } catch (e) {
      resolve({ webhookUrl: '', uqlWidthPct: 20, radarAlerts: false, pinnedPositions: [] });
    }
  });
}

// ---------------------------------------------------------------------------
// Core: token metrics
// ---------------------------------------------------------------------------

function nullMetrics(reason) {
  return {
    ok: false,
    error: reason,
    reason,
    pool: null,
    feeRate: null,
    feeRateRun: null,
    sigma: null,
    edge: null,
    path: null,
    ddHigh: null,
    brackets: null,
    ts: Date.now()
  };
}

// ---------------------------------------------------------------------------
// GMGN official API (openapi.gmgn.ai) — primary rank feed. Key lives in
// chrome.storage.sync (options), NEVER in code. Read endpoints need only
// X-APIKEY + timestamp/client_id query params (±5s validity, fresh UUID).
// ---------------------------------------------------------------------------
async function gmgnRank(interval) {
  const st = await new Promise((res) => chrome.storage.sync.get({ gmgnApiKey: '' }, res));
  const key = (st.gmgnApiKey || '').trim();
  if (!key) return { ok: false, error: 'no GMGN API key set in options' };
  const qs = new URLSearchParams({
    chain: 'robinhood', interval: interval || '1h', limit: '100',
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: crypto.randomUUID()
  });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://openapi.gmgn.ai/v1/market/rank?' + qs, {
      headers: { 'X-APIKEY': key }, signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    // response is double-nested: {code,data:{code,data:{rank:[...]}}}
    let d = j;
    for (let i = 0; i < 3 && d; i++) {
      if (Array.isArray(d.rank)) return { ok: true, rows: d.rank };
      d = d.data;
    }
    if (d && Array.isArray(d.rank)) return { ok: true, rows: d.rank };
    return { ok: false, error: 'unexpected shape (code ' + (j && j.code) + ')' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  }
}

async function getTokenMetrics(tokenAddress) {
  if (!tokenAddress) return nullMetrics('missing token address');
  const settings = await getSettings();
  const W = num(settings.uqlWidthPct, 20) || 20;

  const tp = await fetchTokenPools(String(tokenAddress));
  let pool = (tp.ok && tp.uni.length) ? tp.uni[0] : null; // highest-TVL uniswap pool

  // Fallback (live-verified need): the address may be a POOL address, not a token —
  // e.g. the HUD on app.uniswap.org/explore/pools/robinhood/<pool> extracts the pool
  // address from the path. Treat it as a pool directly (even better: metrics are then
  // computed on the exact pool being viewed).
  if (!pool) {
    const pd = await fetchPoolDetail(String(tokenAddress));
    if (pd.ok && pd.pool) pool = pd.pool;
  }
  if (!pool) {
    return nullMetrics(tp.ok ? 'no Uniswap pool for token on robinhood' : ('token pools fetch failed: ' + tp.error));
  }
  const feeTierPct = (pool.feeTierPct != null) ? pool.feeTierPct : 0.3; // v2 default 0.3%
  const feeTierFrac = feeTierPct / 100;

  // canonical feeRate %/day = vol24 × feeTier ÷ TVL × 100
  const feeRate = (pool.tvl > 0) ? (pool.vol24 * feeTierFrac / pool.tvl * 100) : null;

  // OHLCV -> σ, path, ddHigh, finer run-rate
  const oh = await fetchOhlcvHour(pool.address, 25);
  let sig = { sigma: null, path: null, ddHigh: null, feeRateRun: null };
  if (oh.ok && oh.candles.length) {
    sig = candleSignals(oh.candles, feeTierFrac, pool.tvl, pool.vol24);
  }

  const sigma = sig.sigma;
  const edge = (feeRate != null && sigma != null) ? computeEdge(feeRate, sigma, W) : null;
  const recW = recWidth(sigma);
  const brackets = computeBrackets(recW, feeRate != null ? feeRate : 0);

  return {
    ok: true,
    pool: {
      address: pool.address,
      name: pool.name,
      feeTierPct,
      tvl: pool.tvl,
      vol24: pool.vol24,
      vol5m: pool.vol5m || 0,
      createdAt: pool.createdAt || null
    },
    // HOUSE pool: the highest-fee-tier Uniswap pool for this token (tie -> TVL).
    // User house rule targets the top-tier pool for new pairs; on robinhood the top
    // standard tier is 1% today, but this picks 5%+ automatically if they appear.
    housePool: (tp.ok && tp.uni.length) ? (function () {
      const byTier = tp.uni.slice().sort((x, y) => (num(y.feeTierPct) - num(x.feeTierPct)) || (y.tvl - x.tvl))[0];
      return byTier ? { address: byTier.address, feeTierPct: byTier.feeTierPct, tvl: byTier.tvl, vol5m: byTier.vol5m || 0 } : null;
    })() : { address: pool.address, feeTierPct, tvl: pool.tvl, vol5m: pool.vol5m || 0 },
    feeRate,
    feeRateRun: sig.feeRateRun,       // finer run-rate (extra, not required by contract)
    sigma,
    edge,
    path: sig.path,
    ddHigh: sig.ddHigh,
    brackets,                         // { tp, sl(negative), widthPct = σ-derived }
    priceUsd: pool.priceUsd,          // extra: current token price (USD)
    edgeWidthPct: W,                  // extra: W used for edge (options default)
    ts: Date.now()
  };
}

async function getBreakeven(tokenAddress, widthPct) {
  if (!tokenAddress) return { ok: false, error: 'missing token address' };
  const settings = await getSettings();
  const W = num(widthPct, settings.uqlWidthPct) || num(settings.uqlWidthPct, 20) || 20;

  const m = await getTokenMetrics(String(tokenAddress));
  if (!m || !m.ok) return { ok: false, error: (m && m.error) || 'token metrics unavailable' };
  if (m.sigma == null) return { ok: false, error: 'σ unavailable (no OHLCV candles)' };

  const breakevenFeePerDay = computeBreakeven(m.sigma, W);
  const poolFeePerDay = num(m.feeRate, 0);
  return {
    ok: true,
    breakevenFeePerDay,
    breakevenFeePerDayMargin: breakevenFeePerDay * 1.3, // 1.3-margin variant (extra)
    poolFeePerDay,
    clears: poolFeePerDay >= breakevenFeePerDay,
    widthPct: W,
    sigma: m.sigma
  };
}

// Resolve a pinned position on add: snapshot pool + entryPrice + entryFeeRate.
async function resolvePinned(input) {
  const tokenAddress = String(input.tokenAddress || '').trim();
  if (!tokenAddress) return { ok: false, error: 'missing token address' };
  const m = await getTokenMetrics(tokenAddress);
  if (!m || !m.ok || !m.pool) return { ok: false, error: (m && m.error) || 'could not resolve pool' };

  const entryPrice = num(m.priceUsd, 0) || null;
  const entryFeeRate = (m.feeRate != null) ? m.feeRate : null;
  const recW = (m.brackets && m.brackets.widthPct) ? m.brackets.widthPct : 20;

  let minPrice = num(input.minPrice, NaN);
  let maxPrice = num(input.maxPrice, NaN);
  if (!isFinite(minPrice) || minPrice <= 0) {
    minPrice = entryPrice ? entryPrice * (1 - recW / 100) : null;
  }
  if (!isFinite(maxPrice) || maxPrice <= 0) {
    maxPrice = entryPrice ? entryPrice * (1 + recW / 100) : null;
  }

  const position = {
    id: 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    label: String(input.label || m.pool.name || tokenAddress).slice(0, 60),
    tokenAddress,
    poolAddress: m.pool.address,
    poolName: m.pool.name,
    entryPrice,
    minPrice,
    maxPrice,
    entryFeeRate,
    widthPct: recW,
    ts: Date.now()
  };
  return { ok: true, position };
}

// ---------------------------------------------------------------------------
// Discord + notifications
// ---------------------------------------------------------------------------

async function postDiscord(url, content) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(content).slice(0, 1900) })
    });
  } catch (e) { /* swallow */ }
}

function notify(title, message) {
  try {
    chrome.notifications.create('uql-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), {
      type: 'basic',
      iconUrl: ICON,
      title: String(title || 'Uniswap Quant Lens'),
      message: String(message || ''),
      priority: 2
    });
  } catch (e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Pinned-position watcher (chrome.alarms, 1 min)
// Same alert framework as Meteora Lens: transitions, 2h dedup, Discord + desktop.
// ---------------------------------------------------------------------------

async function watchPinned() {
  let settings;
  try { settings = await getSettings(); } catch (e) { return; }
  const positions = settings.pinnedPositions || [];
  if (!positions.length) return;

  const st = await chrome.storage.local.get({ uqlAlertStates: {}, uqlPosSnap: {} });
  const states = st.uqlAlertStates || {};
  const snaps = st.uqlPosSnap || {};
  const now = Date.now();
  const seen = {};

  for (const pos of positions.slice(0, 12)) {
    try {
      if (!pos || !pos.tokenAddress) continue;
      seen[pos.id] = true;

      // Resolve live pool state (prefer poolAddress detail; fall back to token pools)
      let live = null;
      if (pos.poolAddress) {
        const d = await fetchPoolDetail(pos.poolAddress);
        if (d.ok) live = d.pool;
      }
      if (!live) {
        const tp = await fetchTokenPools(pos.tokenAddress);
        if (tp.ok && tp.uni.length) {
          live = tp.uni.find((p) => pos.poolAddress && p.address.toLowerCase() === String(pos.poolAddress).toLowerCase()) || tp.uni[0];
        }
      }
      if (!live) continue;

      const feeTierPct = (live.feeTierPct != null) ? live.feeTierPct : 0.3;
      const feeTierFrac = feeTierPct / 100;
      const feeRate = (live.tvl > 0) ? (live.vol24 * feeTierFrac / live.tvl * 100) : 0;
      const cur = num(live.priceUsd, 0);
      const name = pos.label || live.name || pos.tokenAddress.slice(0, 8);

      const minP = num(pos.minPrice, 0);
      const maxP = num(pos.maxPrice, 0);
      const entry = num(pos.entryPrice, 0);
      const mid = (minP + maxP) / 2;
      const W = mid > 0 ? ((maxP - minP) / 2 / mid) * 100 : num(pos.widthPct, 20) || 20;
      const tp = Math.round(clampN(W / 4 + feeRate * 0.5, 8, 25));
      const sl = Math.round(clampN(0.75 * W + 2, 8, 20));
      const priceChange = entry > 0 ? (cur - entry) / entry * 100 : 0;

      // fee-decay persistence: feeRate < 50% of entry, two consecutive ticks
      const entryFeeRate = num(pos.entryFeeRate, 0) || feeRate;
      const snap = snaps[pos.id] || { belowCount: 0 };
      if (entryFeeRate > 0 && feeRate < 0.5 * entryFeeRate) snap.belowCount = (snap.belowCount || 0) + 1;
      else snap.belowCount = 0;
      snaps[pos.id] = snap;

      const cond = {};
      if (cur > 0 && minP > 0) cond.OOR_DOWN = cur < minP;
      if (cur > 0 && maxP > 0) cond.OOR_UP = cur > maxP;
      cond.HIT_TP = entry > 0 && priceChange >= tp;
      cond.HIT_SL = entry > 0 && priceChange <= -sl;
      cond.FEE_DECAY = snap.belowCount >= 2;

      const msgs = {
        OOR_DOWN: '🔻 OUT OF RANGE (below): ' + name + ' — price ' + cur.toPrecision(4)
          + ' under your min ' + minP.toPrecision(4) + '. Earning nothing. Δentry ' + priceChange.toFixed(1) + '%',
        OOR_UP: '🔺 OUT OF RANGE (above): ' + name + ' — price ' + cur.toPrecision(4)
          + ' over your max ' + maxP.toPrecision(4) + '. Fully converted. Consider closing. Δentry ' + priceChange.toFixed(1) + '%',
        HIT_TP: '🟢 TP HIT: ' + name + ' at ' + priceChange.toFixed(1) + '% from entry (target +' + tp + '%). Take it.',
        HIT_SL: '🔴 SL HIT: ' + name + ' at ' + priceChange.toFixed(1) + '% from entry (stop -' + sl + '%). Cut it.',
        FEE_DECAY: '📉 FEE ENGINE DYING: ' + name + ' — feeRate ' + feeRate.toFixed(1)
          + '%/day, below 50% of entry (' + entryFeeRate.toFixed(1) + '%/day) twice. The fees were the trade — reassess.'
      };

      for (const k of Object.keys(cond)) {
        const skey = pos.id + ':' + k;
        if (cond[k]) {
          const last = states[skey];
          if (!last || (now - last) >= DEDUP_MS) {
            states[skey] = now;
            await postDiscord(settings.webhookUrl, '**Uniswap Lens** · ' + msgs[k]
              + '\nhttps://app.uniswap.org/positions/create?chain=' + NET + '&currencyA=' + pos.tokenAddress);
            notify('Uniswap Lens', msgs[k]);
          }
        } else if (states[skey]) {
          delete states[skey]; // re-arm when the condition clears
        }
      }
    } catch (e) { /* per-position isolation */ }
  }

  // prune states/snaps for removed positions
  for (const k of Object.keys(states)) {
    const pid = k.split(':')[0];
    if (!seen[pid]) delete states[k];
  }
  for (const pid of Object.keys(snaps)) if (!seen[pid]) delete snaps[pid];

  await chrome.storage.local.set({ uqlAlertStates: states, uqlPosSnap: snaps });
}

// ---------------------------------------------------------------------------
// Radar signal relay: GMGN content script reports a FULL signal.
// Ping Discord (if radarAlerts on) + desktop notification, 2h dedup per token.
// ---------------------------------------------------------------------------

async function handleRadarSignal(item) {
  try {
    if (!item) return;
    const settings = await getSettings();
    if (!settings.radarAlerts || !settings.webhookUrl) return;

    const token = String(item.tokenAddress || item.address || '').toLowerCase();
    if (!token) return;

    const stx = await chrome.storage.local.get({ uqlRadarAlerted: {} });
    const alerted = stx.uqlRadarAlerted || {};
    const now = Date.now();
    if (alerted[token] && (now - alerted[token]) < DEDUP_MS) return;

    const sym = item.symbol || item.name || token.slice(0, 8);
    const edge = (item.edge != null) ? fmt2(item.edge) : '—';
    const msg = '🔥 **Uniswap Lens — radar signal** · ' + sym + ' · edge ' + edge
      + '\nhttps://app.uniswap.org/positions/create?chain=' + NET + '&currencyA=' + (item.tokenAddress || item.address || '');
    await postDiscord(settings.webhookUrl, msg);
    notify('🔥 Radar signal', sym + ' · edge ' + edge);

    alerted[token] = now;
    for (const k of Object.keys(alerted)) if (now - alerted[k] > 24 * 3600e3) delete alerted[k];
    await chrome.storage.local.set({ uqlRadarAlerted: alerted });
  } catch (e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

chrome.alarms.create('uql-watch', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'uql-watch') { watchPinned(); } });
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('uql-watch', { periodInMinutes: 1 }));

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
  }

  if (msg.type === 'getRank') {
    (async () => {
      try { sendResponse(await gmgnRank(msg.interval)); }
      catch (e) { sendResponse({ ok: false, error: String(e).slice(0, 120) }); }
    })();
    return true;
  }
  if (msg.type === 'getTokenMetrics') {
    (async () => {
      try { sendResponse(await getTokenMetrics(msg.tokenAddress)); }
      catch (e) { sendResponse(nullMetrics((e && e.message) ? e.message : String(e))); }
    })();
    return true;
  }

  if (msg.type === 'getBreakeven') {
    (async () => {
      try { sendResponse(await getBreakeven(msg.tokenAddress, msg.widthPct)); }
      catch (e) { sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) }); }
    })();
    return true;
  }

  if (msg.type === 'notify') {
    notify(msg.title, msg.message);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'testWebhook') {
    (async () => {
      try {
        const cfg = await chrome.storage.sync.get({ webhookUrl: '' });
        if (!cfg.webhookUrl) { sendResponse({ ok: false, error: 'no webhook set' }); return; }
        await postDiscord(cfg.webhookUrl, '**Uniswap Lens** · ✅ webhook test — remote alerts are wired. '
          + 'You will get: out-of-range, TP/SL hit, fee-decay, and 🔥 radar signals.');
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) }); }
    })();
    return true;
  }

  if (msg.type === 'radarSignal') {
    handleRadarSignal(msg.item);
    sendResponse({ ok: true });
    return false;
  }

  // Internal (options page): resolve a pinned position before saving.
  if (msg.type === 'resolvePinned') {
    (async () => {
      try { sendResponse(await resolvePinned(msg)); }
      catch (e) { sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) }); }
    })();
    return true;
  }

  sendResponse({ ok: false, error: 'unknown message type: ' + msg.type });
  return false;
});
