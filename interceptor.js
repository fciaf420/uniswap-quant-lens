// Uniswap Quant Lens — page-world interceptor (gmgn.ai).
// GMGN rotates its rank API paths between app versions (seen 2026-07-22:
// /defi/quotation/v1/rank/... -> /trs/api/v1/trending_rank). Instead of chasing
// paths, capture whatever token-rank JSON the page itself receives (fetch + XHR)
// and forward it to the content script via a DOM event. Read-only; never blocks
// or mutates page traffic.
(function () {
  "use strict";
  function looksLikeRankRows(x) {
    if (!x || typeof x !== "object") return null;
    var d = x.data || x;
    var arr = d.rank || d.list || d.tokens || d.trending || (Array.isArray(d) ? d : null);
    if (!Array.isArray(arr) || arr.length < 3) return null;
    var r0 = arr[0];
    if (r0 && typeof r0 === "object" && r0.address && (r0.symbol || r0.name) &&
        ("volume" in r0 || "liquidity" in r0 || "market_cap" in r0)) return arr;
    return null;
  }
  function forward(url, jsonText) {
    try {
      var parsed = JSON.parse(jsonText);
      var rows = looksLikeRankRows(parsed);
      if (!rows) return;
      document.dispatchEvent(new CustomEvent("uql-rank-data", {
        detail: JSON.stringify({ url: String(url).slice(0, 200), ts: Date.now(), rows: rows })
      }));
    } catch (e) {}
  }
  // fetch hook
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    return origFetch.apply(this, args).then(function (resp) {
      try {
        var u = (args[0] && args[0].url) || String(args[0] || "");
        if (/rank|trend|swaps/i.test(u)) {
          resp.clone().text().then(function (t) { forward(u, t); }).catch(function () {});
        }
      } catch (e) {}
      return resp;
    });
  };
  // XHR hook
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__uql_url = url;
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      if (/rank|trend|swaps/i.test(String(xhr.__uql_url || ""))) {
        xhr.addEventListener("load", function () {
          try { forward(xhr.__uql_url, xhr.responseText); } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();

// WebSocket hook — GMGN streams rank updates over WS in newer app versions.
(function () {
  "use strict";
  function tryForwardWs(data) {
    try {
      if (typeof data !== "string" || data.length < 200) return;
      var parsed = JSON.parse(data);
      var d = parsed.data || parsed;
      var arr = d.rank || d.list || d.tokens || (Array.isArray(d) ? d : null);
      if (!Array.isArray(arr) || arr.length < 3) return;
      var r0 = arr[0];
      if (!(r0 && typeof r0 === "object" && r0.address && (r0.symbol || r0.name))) return;
      document.dispatchEvent(new CustomEvent("uql-rank-data", {
        detail: JSON.stringify({ url: "ws", ts: Date.now(), rows: arr })
      }));
    } catch (e) {}
  }
  var OrigWS = window.WebSocket;
  if (!OrigWS) return;
  function WrappedWS(url, protocols) {
    var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener("message", function (ev) { tryForwardWs(ev.data); });
    return ws;
  }
  WrappedWS.prototype = OrigWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { WrappedWS[k] = OrigWS[k]; });
  window.WebSocket = WrappedWS;
})();
