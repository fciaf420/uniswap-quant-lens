'use strict';

const $ = (id) => document.getElementById(id);

function showToast(text, isError) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2200);
}

function setPStatus(text, isError) {
  const el = $('p-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--red)' : 'var(--muted)';
}

function fmt(v, digits) {
  if (v == null || v === '' || isNaN(v)) return '—';
  const n = Number(v);
  if (n !== 0 && Math.abs(n) < 0.001) return n.toPrecision(3);
  return n.toLocaleString(undefined, { maximumFractionDigits: digits == null ? 4 : digits });
}

// ---------------------------------------------------------------------------
// Settings (webhook, width, radar)
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    chrome.storage.sync.get(
      { webhookUrl: '', uqlWidthPct: 20, radarAlerts: false, gmgnApiKey: '' },
      (items) => {
        if (chrome.runtime.lastError) return;
        const it = items || {};
        $('webhookUrl').value = it.webhookUrl || '';
        $('gmgnApiKey').value = it.gmgnApiKey || '';
        $('uqlWidthPct').value = (it.uqlWidthPct != null) ? it.uqlWidthPct : 20;
        $('radarAlerts').checked = !!it.radarAlerts;
      }
    );
  } catch (e) { showToast('Could not read settings', true); }
}

function saveSettings(e) {
  if (e) e.preventDefault();
  const webhookUrl = $('webhookUrl').value.trim();
  const gmgnApiKey = $('gmgnApiKey').value.trim();
  const radarAlerts = $('radarAlerts').checked;
  let uqlWidthPct = parseFloat($('uqlWidthPct').value);
  if (!isFinite(uqlWidthPct) || uqlWidthPct <= 0) uqlWidthPct = 20;
  try {
    chrome.storage.sync.set({ webhookUrl, uqlWidthPct, radarAlerts, gmgnApiKey }, () => {
      if (chrome.runtime.lastError) showToast('Save failed: ' + chrome.runtime.lastError.message, true);
      else showToast('Saved \u2713', false);
    });
  } catch (err) { showToast('Save failed', true); }
}

// ---------------------------------------------------------------------------
// Pinned positions CRUD
// ---------------------------------------------------------------------------

function getPinned() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get({ pinnedPositions: [] }, (items) => {
        if (chrome.runtime.lastError || !items) { resolve([]); return; }
        resolve(Array.isArray(items.pinnedPositions) ? items.pinnedPositions : []);
      });
    } catch (e) { resolve([]); }
  });
}

function setPinned(arr) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set({ pinnedPositions: arr }, () => resolve(!chrome.runtime.lastError));
    } catch (e) { resolve(false); }
  });
}

function renderPinned(arr) {
  const body = $('p-body');
  if (!body) return;
  body.innerHTML = '';
  if (!arr.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="empty" colspan="7">No pinned positions yet.</td>';
    body.appendChild(tr);
    return;
  }
  arr.forEach((p) => {
    const tr = document.createElement('tr');
    const cells = [
      p.label || '—',
      p.poolName || (p.poolAddress ? p.poolAddress.slice(0, 10) + '…' : '—'),
      fmt(p.entryPrice),
      fmt(p.minPrice),
      fmt(p.maxPrice),
      (p.entryFeeRate != null ? Number(p.entryFeeRate).toFixed(1) + '%' : '—')
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (i >= 2 && i <= 5) td.className = 'num';
      td.textContent = c;
      tr.appendChild(td);
    });
    const tdDel = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'del';
    btn.textContent = 'Delete';
    btn.addEventListener('click', async () => {
      const cur = await getPinned();
      const next = cur.filter((x) => x.id !== p.id);
      await setPinned(next);
      renderPinned(next);
    });
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);
    body.appendChild(tr);
  });
}

async function loadPinned() {
  renderPinned(await getPinned());
}

function addPinned() {
  const token = $('p-token').value.trim();
  const label = $('p-label').value.trim();
  const minPrice = $('p-min').value.trim();
  const maxPrice = $('p-max').value.trim();
  if (!token) { setPStatus('Enter a token address.', true); return; }

  setPStatus('Resolving pool + snapshotting entry…', false);
  const addBtn = $('p-add');
  if (addBtn) addBtn.disabled = true;

  try {
    chrome.runtime.sendMessage(
      { type: 'resolvePinned', tokenAddress: token, label, minPrice, maxPrice },
      async (resp) => {
        if (addBtn) addBtn.disabled = false;
        if (chrome.runtime.lastError) { setPStatus('Error: ' + chrome.runtime.lastError.message, true); return; }
        if (!resp || !resp.ok) { setPStatus('Could not add: ' + ((resp && resp.error) || 'unknown error'), true); return; }
        const cur = await getPinned();
        cur.push(resp.position);
        await setPinned(cur);
        renderPinned(cur);
        setPStatus('Added ' + (resp.position.poolName || resp.position.label) + ' \u2713', false);
        $('p-token').value = ''; $('p-label').value = ''; $('p-min').value = ''; $('p-max').value = '';
      }
    );
  } catch (e) {
    if (addBtn) addBtn.disabled = false;
    setPStatus('Error: ' + (e && e.message ? e.message : String(e)), true);
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadPinned();

  const form = $('uql-form');
  if (form) form.addEventListener('submit', saveSettings);

  const t = $('testWebhook');
  if (t) t.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'testWebhook' }, (r) => {
      if (chrome.runtime.lastError) { t.textContent = '\u2717 ' + chrome.runtime.lastError.message; }
      else t.textContent = (r && r.ok) ? '\u2713 sent — check Discord' : ('\u2717 ' + ((r && r.error) || 'save the URL first'));
      setTimeout(() => { t.textContent = 'Send test alert'; }, 4000);
    });
  });

  const add = $('p-add');
  if (add) add.addEventListener('click', addPinned);
});
