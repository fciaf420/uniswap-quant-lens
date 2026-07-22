/* Uniswap Quant Lens — content-uniswap.js (Agent B)
 * HUD + breakeven strip on app.uniswap.org (Robinhood chain).
 * Detects the token in play from the URL, pulls pool metrics from background
 * (getTokenMetrics), renders a fixed dark HUD card (EDGE bar, feeRate vs
 * breakeven, σ, path, TP/SL brackets, recipe), and a live breakeven widget
 * (getBreakeven) driven by a width% input. Read-only: never touches Uniswap's
 * own form inputs (their anchors are unverified — phase 2).
 *
 * NEVER break app.uniswap.org: everything try/catch, idempotent ids, sane
 * z-index, polling pauses when hidden.
 * Contract (implemented blind against Agent A):
 *   {type:"getTokenMetrics", tokenAddress} ->
 *     {ok, pool:{address,name,feeTierPct,tvl,vol24}, feeRate, sigma, edge, path,
 *      ddHigh, brackets:{tp,sl,widthPct}, ts}
 *   {type:"getBreakeven", tokenAddress, widthPct} ->
 *     {ok, breakevenFeePerDay, poolFeePerDay, clears}
 */
(function () {
  "use strict";

  if (window.__uqlUniLoaded) return;
  window.__uqlUniLoaded = true;

  // ---- constants ---------------------------------------------------------
  var POLL_MS = 90000;
  var OBS_DEBOUNCE = 600;
  var INPUT_DEBOUNCE = 400;
  var METRIC_TTL = 75000;
  var NATIVE_ZERO = "0x0000000000000000000000000000000000000000";

  // ---- state -------------------------------------------------------------
  var state = {
    active: false,
    token: null,       // token address in play (lower-preserving original case for links)
    data: null,        // last getTokenMetrics
    lastFetchTs: 0,
    fetching: false,
    pollTimer: null,
    tickTimer: null,
    obs: null,
    widthPct: null,    // current breakeven-widget width
    beDebounce: null,
  };

  // ---- utils -------------------------------------------------------------
  function log() {
    try { if (window.__uqlDebug) console.log.apply(console, ["[UQL/uni]"].concat([].slice.call(arguments))); } catch (e) {}
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
  function num(v) { if (v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
  function fmtNum(v, dp) { if (v == null || isNaN(v)) return "—"; return Number(v).toFixed(dp == null ? 2 : dp); }
  function fmtPct(v, dp) { if (v == null || isNaN(v)) return "—"; return fmtNum(v, dp) + "%"; }
  function fmtCompact(v) {
    if (v == null || isNaN(v)) return "—";
    var n = Number(v);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }
  function isNative(a) {
    if (!a) return true;
    var s = String(a).toLowerCase();
    return s === "native" || s === "eth" || s === "weth" || s === NATIVE_ZERO;
  }
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

  // ---- activation --------------------------------------------------------
  function isRobinhoodContext() {
    try {
      var url = location.href || "";
      if (/chain=robinhood/i.test(url)) return true;
      if (/\/positions\/create/i.test(location.pathname)) return true;
      if (/\/explore\/pools\/robinhood/i.test(location.pathname)) return true;
      return false;
    } catch (e) { return false; }
  }

  // Detect the token in play: currencyA/currencyB or an 0x address in the path.
  function detectToken() {
    try {
      var params = new URLSearchParams(location.search || "");
      var a = params.get("currencyA");
      var b = params.get("currencyB");
      if (a && !isNative(a)) return a;
      if (b && !isNative(b)) return b;
      // path-based: /explore/pools/robinhood/0x.... or any 0x40hex in the path
      var m = (location.pathname || "").match(/0x[a-fA-F0-9]{40}/);
      if (m) return m[0];
      // hash-based routes
      var mh = (location.hash || "").match(/0x[a-fA-F0-9]{40}/);
      if (mh) return mh[0];
      return null;
    } catch (e) { return null; }
  }

  // ========================================================================
  // DATA FETCH + POLL
  // ========================================================================
  var fetchData = safe(function fetchData() {
    if (!state.active || !state.token || state.fetching) return;
    if (document.visibilityState !== "visible") return;
    var now = Date.now();
    if (state.data && (now - state.lastFetchTs) < METRIC_TTL) { renderHUD(); return; }
    state.fetching = true;
    sendMessage({ type: "getTokenMetrics", tokenAddress: state.token }).then(safe(function (resp) {
      state.fetching = false;
      if (resp && resp.ok) {
        state.data = resp;
        state.lastFetchTs = Date.now();
        if (state.widthPct == null) {
          state.widthPct = resp.brackets && resp.brackets.widthPct != null ? resp.brackets.widthPct : 20;
        }
        renderHUD();
        updateBreakeven();
      } else {
        renderHUDError(resp && resp.error);
      }
    }));
  });

  function startPolling() {
    stopPolling();
    fetchData();
    state.pollTimer = setInterval(safe(function () {
      if (document.visibilityState === "visible") fetchData();
    }), POLL_MS);
    state.tickTimer = setInterval(safe(updateAgeLabel), 1000);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  }

  // ========================================================================
  // HUD CARD (#uql-hud) — fixed right side
  // ========================================================================
  function mountHUD() {
    if (document.getElementById("uql-hud")) return;
    var hud = el("div", "uql-card");
    hud.id = "uql-hud";
    document.body.appendChild(hud);
    renderHUD();
  }

  function edgeColorClass(edge) {
    if (edge == null || isNaN(edge)) return "uql-neutral";
    if (edge >= 1) return "uql-good";
    if (edge >= 0.5) return "uql-warn";
    return "uql-bad";
  }

  function headerNode() {
    var h = el("div", "uql-header");
    h.appendChild(el("span", "uql-title", "UNISWAP QUANT LENS"));
    var dot = el("span", "uql-dot", "●");
    h.appendChild(dot);
    return h;
  }

  function footerNode() {
    var f = el("div", "uql-footer");
    var age = el("span", "uql-age", "refreshed just now");
    age.id = "uql-age";
    f.appendChild(age);
    var btn = el("button", "uql-refresh", "↻");
    btn.type = "button";
    btn.title = "Refresh now";
    btn.addEventListener("click", safe(function (e) { e.preventDefault(); e.stopPropagation(); state.lastFetchTs = 0; fetchData(); }));
    f.appendChild(btn);
    return f;
  }

  function labeledRow(label, tipKey, valNode) {
    var row = el("div", "uql-row");
    var lab = el("span", "uql-label", label);
    if (tipKey) lab.setAttribute("data-uql-tip", tipKey);
    row.appendChild(lab);
    row.appendChild(valNode);
    return row;
  }

  var renderHUD = safe(function renderHUD() {
    var hud = document.getElementById("uql-hud");
    if (!hud) return;

    // idle card when no token detected
    if (!state.token) {
      hud.innerHTML = "";
      hud.appendChild(headerNode());
      hud.appendChild(el("div", "uql-idle", "No token detected. Open a position from the GMGN radar, or a Robinhood pool page, and the Lens will read it."));
      return;
    }

    var d = state.data;
    if (!d) {
      hud.innerHTML = "";
      hud.appendChild(headerNode());
      hud.appendChild(el("div", "uql-row uql-muted", "loading pool metrics…"));
      hud.appendChild(footerNode());
      return;
    }

    hud.innerHTML = "";
    hud.appendChild(headerNode());

    // pool line
    var pool = d.pool || {};
    var poolRow = el("div", "uql-poolline");
    poolRow.textContent = (pool.name || "pool") +
      "  ·  TVL $" + fmtCompact(pool.tvl) + "  ·  vol24 $" + fmtCompact(pool.vol24) +
      (pool.feeTierPct != null ? "  ·  fee " + fmtPct(pool.feeTierPct, 2) : "");
    hud.appendChild(poolRow);

    // EDGE row + bar
    var edge = num(d.edge);
    var edgeVal = el("span", "uql-val " + edgeColorClass(edge), fmtNum(edge, 2));
    hud.appendChild(labeledRow("EDGE", "edge", edgeVal));
    var barWrap = el("div", "uql-barwrap");
    var bar = el("div", "uql-bar " + edgeColorClass(edge));
    bar.style.width = Math.max(0, Math.min(100, ((edge || 0) / 2) * 100)) + "%";
    barWrap.appendChild(bar);
    hud.appendChild(barWrap);
    hud.appendChild(el("div", "uql-sub", "fees vs IL-breakeven"));

    // feeRate + σ grid
    var grid = el("div", "uql-grid2");
    grid.appendChild(metricCell("feeRate", "feeRate", fmtPct(num(d.feeRate), 1) + "/d",
      (num(d.feeRate) != null ? "uql-neutral" : "uql-muted")));
    grid.appendChild(metricCell("σ", "sigma", fmtPct(num(d.sigma), 1) + "/d", "uql-neutral"));
    hud.appendChild(grid);

    // path + drawdown
    var pathVal = el("span", "uql-val", (d.path || "—") + "  ▼" + fmtPct(num(d.ddHigh), 1) + " from high");
    if (d.path === "FREEFALL") pathVal.classList.add("uql-bad");
    hud.appendChild(labeledRow("Path", "path", pathVal));

    // brackets
    var br = d.brackets || {};
    var brVal = el("span", "uql-val",
      "TP +" + fmtNum(num(br.tp), 0) + "%  /  SL -" + fmtNum(Math.abs(num(br.sl)), 0) + "%  ·  W ±" + fmtNum(num(br.widthPct), 0) + "%");
    hud.appendChild(labeledRow("Brackets", "brackets", brVal));

    // recipe text
    var recipe = el("div", "uql-recipe");
    var w = num(br.widthPct);
    recipe.textContent = "Spot-style: set range ±" + (w != null ? fmtNum(w, 0) : "W") +
      "% around the current price, enter amounts, Rabby signs. Take profit near +" +
      fmtNum(num(br.tp), 0) + "%, cut by -" + fmtNum(Math.abs(num(br.sl)), 0) + "%.";
    hud.appendChild(recipe);

    // young-token warning (best-effort: pool age is not always in the contract,
    // so we show it whenever age is unknown OR < 24h — Robinhood memecoins are
    // rug-grade, per the guardrails).
    var ageH = poolAgeHours(d);
    if (ageH == null || ageH < 24) {
      hud.appendChild(el("div", "uql-warn-line", "⚠ model prices volatility, not rugs — size for total loss"));
    }

    // breakeven strip
    hud.appendChild(buildBreakevenStrip());

    hud.appendChild(footerNode());
    updateAgeLabel();
    updateBreakeven();
  });

  function poolAgeHours(d) {
    try {
      var p = d.pool || {};
      var cand = p.ageHours != null ? p.ageHours : (d.ageHours != null ? d.ageHours : null);
      if (cand != null) return num(cand);
      // derive from a creation timestamp if present (seconds or ms)
      var ts = p.createdTs != null ? p.createdTs : (p.open_timestamp != null ? p.open_timestamp : null);
      if (ts != null) {
        var t = Number(ts);
        if (t > 1e12) t = t; else t = t * 1000; // seconds -> ms
        return (Date.now() - t) / 3600000;
      }
      return null;
    } catch (e) { return null; }
  }

  function metricCell(label, tipKey, val, cls) {
    var c = el("div", "uql-cell");
    var l = el("div", "uql-cell-l", label);
    if (tipKey) l.setAttribute("data-uql-tip", tipKey);
    c.appendChild(l);
    c.appendChild(el("div", "uql-cell-v " + (cls || ""), val));
    return c;
  }

  // ========================================================================
  // BREAKEVEN STRIP (pure widget — never reads/writes Uniswap's form)
  // ========================================================================
  function buildBreakevenStrip() {
    var wrap = el("div", "uql-be");
    var head = el("div", "uql-be-head");
    var t = el("span", "uql-be-title", "BREAKEVEN");
    t.setAttribute("data-uql-tip", "breakeven");
    head.appendChild(t);
    wrap.appendChild(head);

    var ctrl = el("div", "uql-be-ctrl");
    ctrl.appendChild(el("span", "uql-be-pm", "±"));
    var input = el("input", "uql-be-input");
    input.id = "uql-be-input";
    input.type = "number";
    input.min = "1";
    input.max = "90";
    input.step = "1";
    input.value = state.widthPct != null ? String(Math.round(state.widthPct)) : "20";
    input.addEventListener("input", safe(onWidthInput));
    input.addEventListener("change", safe(onWidthInput));
    ctrl.appendChild(input);
    ctrl.appendChild(el("span", "uql-be-pm", "% half-width"));
    wrap.appendChild(ctrl);

    var res = el("div", "uql-be-res uql-muted", "adjust width to compute…");
    res.id = "uql-be-res";
    wrap.appendChild(res);
    return wrap;
  }

  var onWidthInput = safe(function onWidthInput() {
    var input = document.getElementById("uql-be-input");
    if (!input) return;
    var v = parseFloat(input.value);
    if (!isNaN(v) && v > 0) state.widthPct = v;
    if (state.beDebounce) clearTimeout(state.beDebounce);
    state.beDebounce = setTimeout(safe(updateBreakeven), INPUT_DEBOUNCE);
  });

  var updateBreakeven = safe(function updateBreakeven() {
    var res = document.getElementById("uql-be-res");
    if (!res) return;
    if (!state.token) { res.className = "uql-be-res uql-muted"; res.textContent = "no token"; return; }
    var w = state.widthPct != null ? state.widthPct : 20;
    sendMessage({ type: "getBreakeven", tokenAddress: state.token, widthPct: w }).then(safe(function (resp) {
      var r = document.getElementById("uql-be-res");
      if (!r) return;
      if (!resp || !resp.ok) {
        r.className = "uql-be-res uql-muted";
        r.textContent = "±" + fmtNum(w, 0) + "% breakeven unavailable" + (resp && resp.error ? " (" + resp.error + ")" : "");
        return;
      }
      var need = num(resp.breakevenFeePerDay);
      var pays = num(resp.poolFeePerDay);
      var clears = !!resp.clears;
      r.className = "uql-be-res " + (clears ? "uql-good" : "uql-bad");
      r.textContent = "±" + fmtNum(w, 0) + "% needs ≥" + fmtPct(need, 1) +
        "/day — this pool pays " + fmtPct(pays, 1) + "/day " + (clears ? "✓" : "✗");
    }));
  });

  // ========================================================================
  // AGE LABEL + ERROR
  // ========================================================================
  var updateAgeLabel = safe(function updateAgeLabel() {
    var age = document.getElementById("uql-age");
    if (!age || !state.lastFetchTs) return;
    var secs = Math.round((Date.now() - state.lastFetchTs) / 1000);
    age.textContent = "refreshed " + (secs <= 0 ? "just now" : secs + "s ago");
  });

  var renderHUDError = safe(function renderHUDError(msg) {
    var hud = document.getElementById("uql-hud");
    if (!hud) return;
    hud.innerHTML = "";
    hud.appendChild(headerNode());
    hud.appendChild(el("div", "uql-row uql-bad", "data error: " + (msg || "unknown")));
    var f = el("div", "uql-footer");
    var btn = el("button", "uql-refresh", "↻ retry");
    btn.type = "button";
    btn.addEventListener("click", safe(function (e) { e.preventDefault(); state.lastFetchTs = 0; fetchData(); }));
    f.appendChild(btn);
    hud.appendChild(f);
  });

  // ========================================================================
  // HOVER TOOLTIP ENGINE
  // ========================================================================
  var UQL_TIPS = {
    "edge": "THE core number. LPing = selling insurance: fees are your premium, impermanent loss is the claim you pay when price moves. Edge = fees ÷ expected IL (with a safety margin). ≥1.0 = you're being overpaid for the risk; <1 = the pool is farming YOU. Green ≥1 / yellow ≥0.5 / red below.",
    "sigma": "Realized volatility, %/day — how violently this token actually moves (from GeckoTerminal hourly candles, √t-scaled). High σ = high IL risk: the same fees buy you far less safety.",
    "feeRate": "The live fee run-rate this pool pays, annualized to %/day (pool 24h volume × fee tier ÷ TVL, refined with hourly volume). This is what you actually earn for taking the volatility risk.",
    "path": "Where price sits in its story, from the candles: FREEFALL (actively dumping — never enter), BASING (crashed then stabilized), BLOWOFF (extended at highs), GRIND-UP, CHOP. Also shows drawdown from the recent high.",
    "brackets": "Suggested exits for a ±W% Spot range. TP ≈ W/4 (a clean pump-out of a band only yields ~a quarter of its width) plus a half-day of fees; SL sits just inside the structural band-break. Guidance, not gospel.",
    "breakeven": "IL-breakeven check for a chosen range width: at this pool's volatility, a ±W% range must earn at least X%/day in fees just to offset expected impermanent loss. ✓ = the pool pays more than that; ✗ = the range loses on expectation. Edit the width to test tighter/wider.",
    "flow": "Flow quality from GMGN wallet composition — smart-money + renowned holders vs snipers / rats / bundlers / bots. Shown on the GMGN radar; the HUD relays it when a GMGN tab is open.",
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
    var left = Math.max(8, Math.min(r.left, window.innerWidth - 330));
    var top = r.bottom + 6;
    if (top + 140 > window.innerHeight) top = Math.max(8, r.top - 6 - t.offsetHeight);
    t.style.top = top + "px"; t.style.left = left + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.display = "none"; }
  document.addEventListener("mouseover", function (e) {
    try {
      var m = e.target && e.target.closest && e.target.closest("[data-uql-tip]");
      if (m) showTip(m, m.getAttribute("data-uql-tip")); else hideTip();
    } catch (err) {}
  }, true);

  // ========================================================================
  // OBSERVER + SPA NAV
  // ========================================================================
  var onMutations = (function () {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(safe(function () {
        if (state.active && !document.getElementById("uql-hud")) mountHUD();
      }), OBS_DEBOUNCE);
    };
  })();
  function startObserver() {
    if (state.obs) return;
    state.obs = new MutationObserver(safe(onMutations));
    state.obs.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() { if (state.obs) { state.obs.disconnect(); state.obs = null; } }

  function teardownUI() {
    ["uql-hud", "uql-tooltip"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.parentElement) n.parentElement.removeChild(n);
    });
    tipEl = null;
  }

  var evaluateActivation = safe(function evaluateActivation() {
    var shouldBe = isRobinhoodContext();
    var newToken = shouldBe ? detectToken() : null;

    if (shouldBe && !state.active) {
      state.active = true;
      state.token = newToken;
      state.data = null;
      state.lastFetchTs = 0;
      state.widthPct = null;
      startObserver();
      mountHUD();
      startPolling();
      log("activated", state.token);
      return;
    }
    if (!shouldBe && state.active) {
      state.active = false;
      stopPolling();
      stopObserver();
      teardownUI();
      state.token = null;
      state.data = null;
      log("deactivated");
      return;
    }
    if (shouldBe && state.active && newToken !== state.token) {
      // token changed within an SPA navigation — reset data + refetch
      state.token = newToken;
      state.data = null;
      state.lastFetchTs = 0;
      state.widthPct = null;
      renderHUD();
      fetchData();
      log("token switched", state.token);
    }
  });

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
        if (Date.now() - state.lastFetchTs > POLL_MS) fetchData();
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
