/* Uniswap Quant Lens — content-gmgn.js (Agent B)
 * THE RADAR. Runs on https://gmgn.ai/* — activates only on the robinhood trend page.
 * Same-origin fetch of the GMGN rank API (rides the user's Cloudflare cookies),
 * computes FlowScore + hard safety gates client-side, asks background for pool
 * metrics (getTokenMetrics) for the top rows, injects EDGE pills into table rows,
 * and floats a radar bar of 🔥 FULL / ⚠ near signals with Uniswap deep-links.
 *
 * NEVER break gmgn.ai: every entry point is try/catch wrapped, mounts are
 * idempotent, MutationObserver is debounced, polling pauses when tab hidden.
 * Contract (implemented blind against Agent A):
 *   {type:"getTokenMetrics", tokenAddress} ->
 *     {ok, pool:{address,name,feeTierPct,tvl,vol24}, feeRate, sigma, edge, path,
 *      ddHigh, brackets:{tp,sl,widthPct}, ts}
 *   {type:"radarSignal", item:{tokenAddress,symbol,edge,verdict}}  (fire-and-forget)
 */
(function () {
  "use strict";

  if (window.__uqlGmgnLoaded) return;
  window.__uqlGmgnLoaded = true;

  // ---- constants ---------------------------------------------------------
  var RANK_URL = "/defi/quotation/v1/rank/robinhood/swaps/1h?orderby=swaps&direction=desc";
  var POLL_MS = 90000;       // rank re-fetch cadence while visible
  var OBS_DEBOUNCE = 500;    // mutation observer debounce (table re-renders on sort)
  var TOP_N = 8;             // how many rows (by volume) get pool metrics + pills
  var METRIC_TTL = 75000;    // don't re-request a token's metrics faster than this

  // Hard safety gates: token is BLOCKED regardless of edge if any trip.
  var GATE_RUG_MAX = 0.3;    // rug_ratio > 0.3 => blocked
  var GATE_TOP10_MAX = 0.5;  // top_10_holder_rate > 0.5 => blocked

  // ---- module state ------------------------------------------------------
  var state = {
    active: false,
    rows: [],            // last parsed rank rows (normalized)
    metrics: {},         // addr(lower) -> { data, ts, fetching }
    prevVol: {},         // addr(lower) -> previous poll volume (for "rising")
    firedFull: {},       // addr(lower) -> true (radarSignal dedupe, in-memory)
    pollTimer: null,
    obs: null,
    fetching: false,
    lastRankTs: 0,
  };

  // ---- tiny utils --------------------------------------------------------
  function log() {
    try { if (window.__uqlDebug) console.log.apply(console, ["[UQL/gmgn]"].concat([].slice.call(arguments))); } catch (e) {}
  }
  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { log("err", e && e.message); }
    };
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function num(v) {
    if (v == null) return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }
  function pick(obj, names) {
    if (!obj) return null;
    for (var i = 0; i < names.length; i++) {
      if (obj[names[i]] != null) return obj[names[i]];
    }
    return null;
  }
  function truthy(v) {
    if (v === true) return true;
    if (v === 1) return true;
    if (typeof v === "string") return v === "true" || v === "1";
    return false;
  }
  function fmtNum(v, dp) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(dp == null ? 2 : dp);
  }
  function fmtPct(v, dp) {
    if (v == null || isNaN(v)) return "—";
    return fmtNum(v, dp) + "%";
  }
  function lc(a) { return (a == null ? "" : String(a)).toLowerCase(); }

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message }); return; }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) { resolve({ ok: false, error: e && e.message }); }
    });
  }

  // ---- activation gate ---------------------------------------------------
  function isRobinhoodTrend() {
    try {
      var p = location.pathname || "";
      if (!/\/trend/i.test(p)) return false;
      var q = (location.search || "") + " " + (location.hash || "");
      return /chain=robinhood/i.test(q);
    } catch (e) { return false; }
  }

  // ========================================================================
  // DATA: rank fetch (same-origin, rides CF cookies)
  // ========================================================================
  function normalizeRow(r) {
    if (!r || typeof r !== "object") return null;
    var address = pick(r, ["address", "token_address", "contract", "id"]);
    if (!address) return null;
    return {
      address: String(address),
      symbol: pick(r, ["symbol", "token_symbol"]) || pick(r, ["name"]) || "—",
      name: pick(r, ["name", "token_name"]) || "",
      price: num(pick(r, ["price", "usd_price"])),
      pc5m: num(pick(r, ["price_change_percent5m", "price_change_percent_5m", "price_change_5m", "priceChange5m"])),
      pc1h: num(pick(r, ["price_change_percent1h", "price_change_percent_1h", "price_change_1h", "price_change_percent"])),
      pc1m: num(pick(r, ["price_change_percent1m", "price_change_percent_1m", "price_change_1m"])),
      volume: num(pick(r, ["volume", "volume_1h", "swaps_volume", "v", "volume_24h"])),
      liquidity: num(pick(r, ["liquidity", "liq", "pool_liquidity"])),
      smartDegen: num(pick(r, ["smart_degen_count", "smartDegenCount"])) || 0,
      renowned: num(pick(r, ["renowned_count", "renownedCount"])) || 0,
      ratRate: num(pick(r, ["rat_trader_amount_rate", "ratTraderAmountRate"])) || 0,
      bundlerRate: num(pick(r, ["bundler_rate", "bundlerRate"])) || 0,
      botDegenRate: num(pick(r, ["bot_degen_rate", "botDegenRate"])) || 0,
      sniperCount: num(pick(r, ["sniper_count", "sniperCount"])) || 0,
      rugRatio: num(pick(r, ["rug_ratio", "rugRatio"])),
      isHoneypot: truthy(pick(r, ["is_honeypot", "honeypot"])),
      isWash: truthy(pick(r, ["is_wash_trading", "wash_trading", "is_wash"])),
      top10: num(pick(r, ["top_10_holder_rate", "top10_holder_rate", "top_10_holders_rate"])),
      openTs: num(pick(r, ["open_timestamp", "openTimestamp", "created_timestamp"])),
      mcap: num(pick(r, ["market_cap", "mcap", "marketCap"])),
      launchpad: String(pick(r, ["launchpad"]) || "") + " " + String(pick(r, ["launchpad_platform"]) || ""),
    };
  }

  // Primary feed (2026-07-22+): GMGN rotates rank API paths between app versions,
  // so interceptor.js (MAIN world) forwards whatever rank JSON the page itself
  // receives. Works regardless of endpoint/method/version.
  function ingestRows(arr, srcUrl) {
    var rows = [];
    for (var i = 0; i < arr.length; i++) {
      var nrm = normalizeRow(arr[i]);
      if (nrm) rows.push(nrm);
    }
    if (!rows.length) return;
    state.rows = rows;
    state.lastRankTs = Date.now();
    log("rank via " + (srcUrl ? srcUrl.split("?")[0] : "direct") + ": " + rows.length + " rows");
    onRankUpdated();
  }

  document.addEventListener("uql-rank-data", safe(function (ev) {
    if (!state.active) return;
    var payload = null;
    try { payload = JSON.parse(ev.detail); } catch (e) { return; }
    if (payload && Array.isArray(payload.rows)) ingestRows(payload.rows, payload.url);
  }));

  var fetchRank = safe(function fetchRank() {
    if (!state.active || state.fetching) return;
    if (document.visibilityState !== "visible") return;
    state.fetching = true;
    // PRIMARY: official GMGN API via background (user's key, openapi.gmgn.ai).
    sendMessage({ type: "getRank", interval: "1h" }).then(safe(function (resp) {
      state.fetching = false;
      if (resp && resp.ok && Array.isArray(resp.rows)) { ingestRows(resp.rows, "openapi"); return; }
      log("official rank failed: " + (resp && resp.error) + " — falling back to page feed");
      legacyFetchRank();
    })).catch(safe(function () { state.fetching = false; legacyFetchRank(); }));
  });

  // FALLBACK: the site's internal endpoint (breaks when GMGN rotates app versions;
  // interceptor.js + this stay as backup only).
  var legacyFetchRank = safe(function legacyFetchRank() {
    if (state.lastRankTs && Date.now() - state.lastRankTs < 120000) return;
    state.fetching = true;
    fetch(RANK_URL, { credentials: "include", headers: { "accept": "application/json" } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
      .then(safe(function (json) {
        state.fetching = false;
        // defensively handle {code:0,data:{rank:[...]}} and a few shapes
        var arr = null;
        if (json && json.data && Array.isArray(json.data.rank)) arr = json.data.rank;
        else if (json && Array.isArray(json.rank)) arr = json.rank;
        else if (json && json.data && Array.isArray(json.data)) arr = json.data;
        else if (Array.isArray(json)) arr = json;
        if (!arr) { log("no rank array", json && json.code); return; }
        ingestRows(arr, RANK_URL);
      }))
      .catch(safe(function (e) { state.fetching = false; log("rank fetch failed", e && e.message); }));
  });

  // ========================================================================
  // FLOW SCORE + SAFETY GATES (client-side)
  // ========================================================================
  // Composite flow-quality analog (replaces Jupiter OFI). Positive = real /
  // smart flow; penalties for rats, bundlers, snipers, bots. Signed number.
  function flowScore(row) {
    var s = (row.smartDegen || 0) + (row.renowned || 0);
    s -= (row.sniperCount || 0) * 0.5;
    s -= (row.ratRate || 0) * 10;
    s -= (row.bundlerRate || 0) * 10;
    s -= (row.botDegenRate || 0) * 10;
    return s;
  }
  function flowClean(row) {
    // "clean" flow: not sell/rat-skewed. Used as a FULL-signal quality hint.
    return flowScore(row) >= 0 && (row.ratRate || 0) < 0.3 && (row.bundlerRate || 0) < 0.3;
  }
  // Returns array of gate-fail reasons; empty => passes hard gates.
  function safetyFails(row) {
    var f = [];
    if (row.isHoneypot) f.push("honeypot");
    if (row.isWash) f.push("wash-trading");
    if (row.rugRatio != null && row.rugRatio > GATE_RUG_MAX) f.push("rug " + fmtNum(row.rugRatio, 2));
    if (row.top10 != null && row.top10 > GATE_TOP10_MAX) f.push("top10 " + Math.round(row.top10 * 100) + "%");
    // HOUSE RULE: never touch flap.fun launchpad tokens (user rule, hard block).
    if (/flap/i.test(row.launchpad || "")) f.push("flap.fun");
    return f;
  }

  // =====================================================================
  // HOUSE RULES (user playbook, 2026-07-22 — priors from live trading):
  //  1. NEW PAIRS (<24h): only play top-tier fee pools (>=1% — the Uniswap
  //     equivalent of "base fee 5%" on DLMM) AND 5-min vol >= $300k.
  //  2. DIP-SET: mcap <= $2M and >=50% off the high — the bottom-set spot
  //     ("often get 30-50% here"). Surfaced as 🎯 chips, still safety-gated.
  // =====================================================================
  var HOUSE_NEWPAIR_AGE_H = 24;
  var HOUSE_NEWPAIR_MIN_TIER = 1.0;   // feeTierPct
  var HOUSE_NEWPAIR_MIN_VOL5M = 300000; // USD per 5 min
  var HOUSE_DIP_MAX_MCAP = 2e6;
  var HOUSE_DIP_MIN_DD = 50;          // % from high

  function tokenAgeH(row) {
    if (!row.openTs) return null;
    return (Date.now() / 1000 - row.openTs) / 3600;
  }

  // Returns null if OK, or a short reason string when the new-pair rule blocks.
  function newPairViolation(row, m) {
    var age = tokenAgeH(row);
    if (age == null || age >= HOUSE_NEWPAIR_AGE_H) return null; // not a new pair
    var hp = m && (m.housePool || m.pool);
    if (!hp) return null;
    var tier = num(hp.feeTierPct), v5 = num(hp.vol5m);
    if (tier < HOUSE_NEWPAIR_MIN_TIER) return "new<24h: tier " + tier + "% < " + HOUSE_NEWPAIR_MIN_TIER + "%";
    if (v5 < HOUSE_NEWPAIR_MIN_VOL5M) return "new<24h: vol5m $" + fmtCompact(v5) + " < $300K";
    return null;
  }

  // House GO signal: user's playbook conditions fully met -> 🎯 chip saying go LP.
  // Two flavors: NEW-PAIR (fresh token, top-tier pool, 5-min vol hot) and
  // DIP-SET (<=2M mcap, >=50% off high -> set at the bottom).
  function houseSignal(row, m) {
    if (!m || !m.ok) return null;
    var hp = m.housePool || m.pool;
    var age = tokenAgeH(row);
    if (age != null && age < HOUSE_NEWPAIR_AGE_H && hp &&
        num(hp.feeTierPct) >= HOUSE_NEWPAIR_MIN_TIER && num(hp.vol5m) >= HOUSE_NEWPAIR_MIN_VOL5M) {
      return { type: "NEW-PAIR", pool: hp,
        why: "fresh pair " + fmtNum(age, 1) + "h · top tier " + hp.feeTierPct + "% · vol5m $" + fmtCompact(hp.vol5m) };
    }
    if (isDipSet(row, m)) {
      return { type: "DIP-SET", pool: m.pool,
        why: "mcap $" + fmtCompact(row.mcap) + " · ▼" + fmtNum(num(m.ddHigh), 0) + "% from high — bottom-set zone" };
    }
    return null;
  }

  function isDipSet(row, m) {
    if (!m || m.ddHigh == null) return false;
    if (!(row.mcap > 0 && row.mcap <= HOUSE_DIP_MAX_MCAP)) return false;
    return num(m.ddHigh) >= HOUSE_DIP_MIN_DD;
  }

  // ========================================================================
  // METRICS: request pool metrics from background for the top rows
  // ========================================================================
  function topRows() {
    var rows = state.rows.slice();
    rows.sort(function (a, b) { return (b.volume || 0) - (a.volume || 0); });
    return rows.slice(0, TOP_N);
  }

  var requestMetricsForTop = safe(function requestMetricsForTop() {
    var top = topRows();
    top.forEach(function (row) {
      // skip hard-blocked tokens (don't waste GT budget on rugs)
      if (safetyFails(row).length) return;
      var key = lc(row.address);
      var cur = state.metrics[key];
      var now = Date.now();
      if (cur && cur.fetching) return;
      if (cur && cur.data && (now - cur.ts) < METRIC_TTL) return;
      state.metrics[key] = { data: cur ? cur.data : null, ts: cur ? cur.ts : 0, fetching: true };
      sendMessage({ type: "getTokenMetrics", tokenAddress: row.address }).then(safe(function (resp) {
        var slot = state.metrics[key] || {};
        slot.fetching = false;
        if (resp && resp.ok) { slot.data = resp; slot.ts = Date.now(); }
        state.metrics[key] = slot;
        renderRows();
        renderRadar();
      }));
    });
  });

  // ========================================================================
  // SIGNAL CLASSIFICATION
  // ========================================================================
  // Returns { kind:"FULL"|"NEAR"|"NONE", edge, blocked, fails, reasons }
  function classify(row) {
    var fails = safetyFails(row);
    var slot = state.metrics[lc(row.address)];
    var m = slot && slot.data ? slot.data : null;
    var edge = m ? num(m.edge) : null;
    if (fails.length) {
      return { kind: "NONE", edge: edge, blocked: true, fails: fails, m: m, dip: false };
    }
    var np = newPairViolation(row, m);
    var dip = isDipSet(row, m);
    if (edge == null) return { kind: "NONE", edge: null, blocked: false, fails: [], m: m, dip: dip, np: np };

    // accel-equivalent: price_change_5m>0 AND volume rising
    var prev = state.prevVol[lc(row.address)];
    var volRising = prev != null && row.volume != null ? row.volume > prev : false;
    var accelOk = (row.pc5m != null && row.pc5m > 0) && volRising;
    var pathOk = m.path !== "FREEFALL";

    if (edge >= 1 && accelOk && pathOk && flowClean(row) && !np) {
      return { kind: "FULL", edge: edge, blocked: false, fails: [], m: m, accelOk: accelOk, dip: dip };
    }
    if (edge >= 0.5 || dip) {
      var miss = [];
      if (edge < 1) miss.push("edge<1");
      if (!accelOk) miss.push("accel");
      if (!pathOk) miss.push("path");
      if (!flowClean(row)) miss.push("flow");
      if (np) miss.push(np);
      return { kind: "NEAR", edge: edge, blocked: false, fails: miss, m: m, dip: dip, np: np };
    }
    return { kind: "NONE", edge: edge, blocked: false, fails: [], m: m, dip: dip, np: np };
  }

  function edgeColorClass(edge) {
    if (edge == null || isNaN(edge)) return "uql-neutral";
    if (edge >= 1) return "uql-good";
    if (edge >= 0.5) return "uql-warn";
    return "uql-bad";
  }

  // ========================================================================
  // ROW PILL INJECTION (idempotent, MutationObserver-safe)
  // ========================================================================
  // Find the table row that references a token address via any link href.
  function rowForAddress(addr) {
    try {
      var a = document.querySelector('a[href*="' + addr + '"]');
      if (!a) {
        // case-insensitive fallback scan
        var links = document.querySelectorAll('a[href]');
        var low = lc(addr);
        for (var i = 0; i < links.length; i++) {
          if (lc(links[i].getAttribute("href")).indexOf(low) !== -1) { a = links[i]; break; }
        }
      }
      if (!a) return null;
      return a.closest("tr") || a.closest('[role="row"]') || null;
    } catch (e) { return null; }
  }

  function buildPill(row, cls) {
    var pill = el("span", "uql-pill");
    pill.setAttribute("data-uql-addr", lc(row.address));
    var m = cls.m;
    if (cls.blocked) {
      pill.className = "uql-pill uql-bad";
      pill.textContent = "⛔ BLOCKED";
      pill.title = "Uniswap Quant Lens: hard safety gate tripped — " + cls.fails.join(", ") + ". Do not LP.";
      return pill;
    }
    if (!m) {
      pill.className = "uql-pill uql-neutral";
      pill.textContent = "…";
      pill.title = "Uniswap Quant Lens: fetching pool metrics…";
      return pill;
    }
    var edge = num(m.edge);
    pill.className = "uql-pill " + edgeColorClass(edge);
    var hsPill = cls.blocked ? null : houseSignal(row, cls.m);
    var mark = cls.kind === "FULL" ? "🔥 " : (cls.kind === "NEAR" ? "⚠ " : "");
    if (hsPill) mark = "🎯 " + mark;
    pill.textContent = mark + "E " + fmtNum(edge, 2);
    var fs = flowScore(row);
    var poolNm = m.pool && m.pool.name ? m.pool.name : "—";
    pill.title =
      "Uniswap Quant Lens — " + (row.symbol || "") + "\n" +
      "EDGE " + fmtNum(edge, 2) + " (fees vs IL-breakeven)\n" +
      "feeRate " + fmtPct(num(m.feeRate), 1) + "/day  ·  σ " + fmtPct(num(m.sigma), 1) + "/day\n" +
      "path " + (m.path || "—") + "  ·  ▼" + fmtPct(num(m.ddHigh), 1) + " from high\n" +
      "FlowScore " + fmtNum(fs, 1) + " (smart " + row.smartDegen + " / renowned " + row.renowned +
        " / sniper " + row.sniperCount + ")\n" +
      "pool " + poolNm + "  ·  TVL $" + fmtCompact(m.pool && m.pool.tvl) + "  vol24 $" + fmtCompact(m.pool && m.pool.vol24) +
      (hsPill ? "\n🎯 HOUSE " + hsPill.type + ": " + hsPill.why + " — GO LP the " + (hsPill.pool && hsPill.pool.feeTierPct != null ? hsPill.pool.feeTierPct + "%" : "target") + " pool" : "") +
      "\n\u21b1 click to open this pool on Uniswap (address copied too)";
    // Clickable: any scored pill jumps straight to the pool's Uniswap page.
    var poolAddr = m.pool && m.pool.address ? m.pool.address : null;
    pill.classList.add("uql-pill-link");
    pill.addEventListener("click", safe(function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      copyAndToast(row.address);
      try { window.open(uniswapDeepLink(row.address, poolAddr), "_blank", "noopener"); } catch (e) {}
    }), true);
    return pill;
  }

  function fmtCompact(v) {
    if (v == null || isNaN(v)) return "—";
    var n = Number(v);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  var renderRows = safe(function renderRows() {
    if (!state.active) return;
    var top = topRows();
    top.forEach(function (row) {
      var cls = classify(row);
      // only inject pills for scored (top) rows; blocked also shows a marker
      var tr = rowForAddress(row.address);
      if (!tr) return;
      var key = lc(row.address);
      var existing = tr.querySelector('.uql-pill[data-uql-addr="' + key + '"]');
      var pill = buildPill(row, cls);
      if (existing) {
        // update in place (avoid duplicate mounts on re-render)
        if (existing.parentElement) existing.parentElement.replaceChild(pill, existing);
        return;
      }
      // mount into the first cell so it rides along on horizontal scroll
      var cell = tr.querySelector("td, th, [role='cell']") || tr;
      var host = el("span", "uql-pill-host");
      host.appendChild(pill);
      cell.appendChild(host);
    });
  });

  // ========================================================================
  // RADAR BAR (bottom-right) + toast
  // ========================================================================
  var radarCollapsed = false;

  function currentSignals() {
    var full = [], near = [], house = [];
    topRows().forEach(function (row) {
      var cls = classify(row);
      var hs = cls.blocked ? null : houseSignal(row, cls.m);
      if (hs) house.push({ row: row, cls: cls, hs: hs });
      if (cls.kind === "FULL") full.push({ row: row, cls: cls });
      else if (cls.kind === "NEAR") near.push({ row: row, cls: cls });
    });
    full.sort(function (a, b) { return (b.cls.edge || 0) - (a.cls.edge || 0); });
    near.sort(function (a, b) { return (b.cls.edge || 0) - (a.cls.edge || 0); });
    house.sort(function (a, b) { return (b.cls.edge || 0) - (a.cls.edge || 0); });
    return { full: full, near: near, house: house };
  }

  function makeHouseChip(sig) {
    var row = sig.row, hs = sig.hs;
    var chip = el("button", "uql-chip uql-chip-house");
    chip.textContent = "🎯 " + row.symbol + " · " + hs.type;
    chip.title = "HOUSE RULE MET — " + hs.type + ": " + hs.why +
      "\nGO LP: opens the " + (hs.pool && hs.pool.feeTierPct != null ? hs.pool.feeTierPct + "%" : "target") + " pool on Uniswap (address copied too)." +
      (hs.type === "DIP-SET" ? "\nPlaybook: set at the bottom — often 30-50% here." : "\nPlaybook: new pairs only on the top-tier pool with vol5m ≥ $300K.");
    chip.addEventListener("click", safe(function () {
      copyAndToast(row.address);
      var pa = hs.pool && hs.pool.address ? hs.pool.address : null;
      try { window.open(uniswapDeepLink(row.address, pa), "_blank", "noopener"); } catch (e) {}
    }));
    return chip;
  }

  function uniswapDeepLink(addr, poolAddr) {
    // LIVE-VERIFIED: the explore-pool URL renders the pool page (with the New Position
    // path one click away) on robinhood. The positions/create param format was tested
    // and FAILS without a connected wallet (app resets to chain=ethereum) — only used
    // as last-resort fallback when we have no pool address.
    if (poolAddr) {
      return "https://app.uniswap.org/explore/pools/robinhood/" + encodeURIComponent(poolAddr);
    }
    return "https://app.uniswap.org/positions/create?chain=robinhood&currencyA=" +
      encodeURIComponent(addr) + "&currencyB=NATIVE";
  }

  function copyAndToast(addr) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(addr).catch(function () {});
      }
    } catch (e) {}
    showToast("address copied — paste in Uniswap token selector if deep-link misses");
  }

  var toastTimer = null;
  function showToast(msg) {
    var t = document.getElementById("uql-toast");
    if (!t) { t = el("div", ""); t.id = "uql-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = "uql-toast-show";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { var n = document.getElementById("uql-toast"); if (n) n.className = ""; }, 4200);
  }

  function makeChip(sig, isFull) {
    var row = sig.row, cls = sig.cls;
    var chip = el("button", "uql-chip " + (isFull ? "uql-chip-full" : "uql-chip-near"));
    if (isFull) {
      chip.textContent = "🔥 " + row.symbol + " · edge " + fmtNum(cls.edge, 2);
      chip.title = "FULL signal: edge≥1, accel + safe + path OK. Click to open Uniswap create-position (address also copied).";
    } else {
      chip.textContent = "⚠ " + row.symbol + " · edge " + fmtNum(cls.edge, 2) + " · misses " + (cls.fails || []).join("+");
      chip.title = "Near-miss (edge≥0.5): " + (cls.fails || []).join(", ") + ". Click to open Uniswap (address also copied).";
    }
    chip.addEventListener("click", safe(function () {
      copyAndToast(row.address);
      var poolAddr = cls.m && cls.m.pool && cls.m.pool.address ? cls.m.pool.address : null;
      try { window.open(uniswapDeepLink(row.address, poolAddr), "_blank", "noopener"); } catch (e) {}
    }));
    return chip;
  }

  var renderRadar = safe(function renderRadar() {
    if (!state.active) return;
    var bar = document.getElementById("uql-radar");
    if (!bar) { bar = el("div", ""); bar.id = "uql-radar"; document.body.appendChild(bar); }
    bar.innerHTML = "";

    var head = el("span", "uql-radar-title", "📡 RADAR");
    head.setAttribute("data-uql-tip", "radar");
    head.style.cursor = "pointer";
    head.addEventListener("click", function () {
      radarCollapsed = !radarCollapsed;
      bar.classList.toggle("uql-radar-min", radarCollapsed);
      renderRadar();
    });
    bar.appendChild(head);

    var sigs = currentSignals();
    if (radarCollapsed) {
      bar.appendChild(el("span", "uql-radar-empty",
        sigs.house.length + "🎯 " + sigs.full.length + "🔥 " + sigs.near.length + "⚠"));
      return;
    }
    if (!sigs.full.length && !sigs.near.length && !sigs.house.length) {
      var msg = state.lastRankTs ? "nothing actionable on the board" : "loading radar…";
      bar.appendChild(el("span", "uql-radar-empty", msg));
    } else {
      sigs.house.forEach(function (s) { bar.appendChild(makeHouseChip(s)); });
      sigs.full.forEach(function (s) { bar.appendChild(makeChip(s, true)); });
      sigs.near.forEach(function (s) { bar.appendChild(makeChip(s, false)); });
    }
    if (state.lastRankTs) {
      bar.appendChild(el("span", "uql-radar-ts", Math.round((Date.now() - state.lastRankTs) / 60000) + "m"));
    }
  });

  // fire radarSignal once per token when it first reaches FULL
  function fireNewFullSignals() {
    var sigs = currentSignals();
    sigs.full.forEach(function (s) {
      var key = lc(s.row.address);
      if (state.firedFull[key]) return;
      state.firedFull[key] = true;
      sendMessage({
        type: "radarSignal",
        item: { tokenAddress: s.row.address, symbol: s.row.symbol, edge: s.cls.edge, verdict: "FULL" }
      });
      log("radarSignal fired", s.row.symbol, s.cls.edge);
    });
    // allow re-fire if a token drops out of FULL and returns later
    Object.keys(state.firedFull).forEach(function (key) {
      var still = sigs.full.some(function (s) { return lc(s.row.address) === key; });
      if (!still) delete state.firedFull[key];
    });
  }

  // ========================================================================
  // ORCHESTRATION
  // ========================================================================
  var onRankUpdated = safe(function onRankUpdated() {
    requestMetricsForTop();
    renderRows();
    renderRadar();
    fireNewFullSignals();
    // stash volumes AFTER classification so "rising" compares poll-to-poll
    topRows().forEach(function (row) { state.prevVol[lc(row.address)] = row.volume; });
  });

  // ---- hover tooltip engine (static explainers) --------------------------
  var UQL_TIPS = {
    "radar": "Board-wide scanner for Robinhood-chain tokens. Every 90s it screens the most-active tokens, joins each to its Uniswap pool, and pins the actionable ones. 🔥 = FULL signal (edge≥1, price rising last 5m, volume building, safety gates green, not in freefall). ⚠ = near-miss (edge≥0.5). Click a chip to open Uniswap create-position (the token address is also copied to your clipboard as a fallback). Click 📡 RADAR to collapse.",
    "edge": "THE core number. LPing = selling insurance: fees are your premium, impermanent loss is the claim you pay when price moves. Edge = fees ÷ expected IL (with a safety margin). ≥1.0 = you're being overpaid for the risk; <1 = the pool is farming YOU. Green ≥1 / yellow ≥0.5 / red below.",
    "flow": "FlowScore — a composite of GMGN wallet quality: smart-money + renowned holders push it up, snipers / rat-traders / bundlers / bots pull it down. Positive & clean = organic; negative = manipulated flow you'd be buying into.",
    "block": "Hard safety gate tripped (honeypot, wash-trading, rug_ratio>0.3, or top-10 holders >50%). BLOCKED tokens never surface as signals no matter how good the edge looks.",
  };
  var tipEl = null;
  function ensureTipEl() {
    if (tipEl && document.body.contains(tipEl)) return tipEl;
    tipEl = el("div", ""); tipEl.id = "uql-tooltip"; document.body.appendChild(tipEl);
    return tipEl;
  }
  function showTip(target, key) {
    var txt = UQL_TIPS[key]; if (!txt) return;
    var t = ensureTipEl();
    t.textContent = txt; t.style.display = "block";
    var r = target.getBoundingClientRect();
    var top = r.top - 8, left = Math.min(r.left, window.innerWidth - 320);
    // radar sits bottom-right; place tooltip above it
    if (top - 120 < 8) top = r.bottom + 8;
    else top = r.top - 8 - t.offsetHeight;
    t.style.top = Math.max(8, top) + "px";
    t.style.left = Math.max(8, left) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.display = "none"; }
  document.addEventListener("mouseover", function (e) {
    try {
      var m = e.target && e.target.closest && e.target.closest("[data-uql-tip]");
      if (m) showTip(m, m.getAttribute("data-uql-tip")); else hideTip();
    } catch (err) {}
  }, true);

  // ---- mutation observer (table re-renders on sort/refresh) --------------
  var onMutations = (function () {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(safe(function () { if (state.active) renderRows(); }), OBS_DEBOUNCE);
    };
  })();

  function startObserver() {
    if (state.obs) return;
    state.obs = new MutationObserver(safe(onMutations));
    state.obs.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (state.obs) { state.obs.disconnect(); state.obs = null; }
  }

  // ---- polling -----------------------------------------------------------
  function startPolling() {
    stopPolling();
    fetchRank();
    state.pollTimer = setInterval(safe(function () {
      if (document.visibilityState === "visible") fetchRank();
    }), POLL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  // ---- activation / teardown on SPA nav ----------------------------------
  function teardownUI() {
    ["uql-radar", "uql-toast", "uql-tooltip"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.parentElement) n.parentElement.removeChild(n);
    });
    document.querySelectorAll(".uql-pill-host").forEach(function (n) {
      if (n.parentElement) n.parentElement.removeChild(n);
    });
    tipEl = null;
  }

  var evaluateActivation = safe(function evaluateActivation() {
    var shouldBe = isRobinhoodTrend();
    if (shouldBe && !state.active) {
      state.active = true;
      startObserver();
      startPolling();
      renderRadar();
      log("activated");
    } else if (!shouldBe && state.active) {
      state.active = false;
      stopPolling();
      stopObserver();
      teardownUI();
      state.rows = [];
      log("deactivated");
    }
  });

  // ---- SPA history hooks -------------------------------------------------
  function hookHistory() {
    try {
      var wrap = function (name) {
        var orig = history[name];
        if (!orig || orig.__uqlWrapped) return;
        var patched = function () {
          var ret = orig.apply(this, arguments);
          try { window.dispatchEvent(new Event("uql:locationchange")); } catch (e) {}
          return ret;
        };
        patched.__uqlWrapped = true;
        history[name] = patched;
      };
      wrap("pushState");
      wrap("replaceState");
      window.addEventListener("popstate", safe(evaluateActivation));
      window.addEventListener("uql:locationchange", safe(evaluateActivation));
    } catch (e) { log("history hook failed", e && e.message); }
  }

  // ========================================================================
  // BOOT
  // ========================================================================
  var boot = safe(function boot() {
    hookHistory();
    document.addEventListener("visibilitychange", safe(function () {
      if (document.visibilityState === "visible" && state.active) {
        if (Date.now() - state.lastRankTs > POLL_MS) fetchRank();
      }
    }));
    evaluateActivation();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
