// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Live Floatation (Walk-in) endpoint
//
// Reads the 5 W0X "Customer Floatation Report 2026" Google Sheets directly
// (each is shared "anyone with link can view" — verified 2026-05-06), parses
// the CSV export, and returns a JSON shape that drop-in replaces the legacy
// hardcoded RACE_DATA literal that used to live in tools/build-today.py.
//
// V1 第 8 刀 — 2026-05-06: kills the "Jym pastes April → portal still
// shows March" loop for the walk-in / footfall section. Refresh button now
// pulls THIS endpoint and the dashboard renders true live numbers.
//
// Sheets (link-shared, public read):
//   W01: 1FgXzgOUMmF8UVA9lcuBwd9nfbY2Sw_LY6GZVnNJcvRw
//   W02: 15dvmfamAhjsKP8ANllKlDhBDumNfDfx_iOlr5W48lZA
//   W03: 1syxvPHOMOtIVICVcG1ZyscOJ-Lih_rPEiYZRsPTN0y8
//   W05: 1KMUZGkfLrdkJh5-ECuzDbHRClatykFBlFIOZKqqirY8
//   W07: 1-yUL4N6UPuaUbHua0rHew3HvwqqXCvQ0cYDuMLcN-aE
//
// Each sheet has the same layout: 5 races × 5 metrics, 13 monthly cols.
//
//   row 0:  ,,All,Jan,Feb,Mar,...,Dec
//   row 1:  All,Walk-in,<sum>,<jan>,...
//   row 2:  ,Purchase,<sum>,<jan>,...
//   row 3:  ,Amount,<sum>,<jan>,...
//   row 4:  ,Average Basket Size,<all>,<jan>,...
//   row 5:  ,Closing Rate,<all>,<jan>,...
//   row 6:  Chinese,Walk-in,...
//   ... (Malay / India(n) / Others) ...
//
// Returns shape compatible with WP_TODAY.race contract (see Wiltek_MASTER.html
// renderCustomersDashboard race section):
//   {
//     ok: true,
//     fetched_at: "2026-05-06T...",
//     year: 2026,
//     months: ["2026-MM", ...],   // 3-month window: latest month with data + 2 prior
//     month_idx: [..],            // 1-based month numbers in the window
//     races: [
//       { key, label_en, label_zh, walkin:[..], purchase:[..], amount:[..], basket:[..], cr:[..] },
//     ],
//     totals: { walkin, purchase, amount, basket, cr },
//     by_branch: {
//       W01: { walkin, purchase, amount, basket, cr },   // single number per branch (sum of window)
//       ...
//     },
//     branches_full: { W01: { months, races, totals }, ... },  // full per-branch detail
//     diagnostics: { ... per-branch fetch status, parse warnings ... }
//   }
//
// Caching: this endpoint is hit by the Refresh button — caller adds ?t=ts to
// bust browser cache. We pass the same to upstream Google. No server cache.
// ═══════════════════════════════════════════════════════════════════════

const SHEETS = {
  W01: '1FgXzgOUMmF8UVA9lcuBwd9nfbY2Sw_LY6GZVnNJcvRw',
  W02: '15dvmfamAhjsKP8ANllKlDhBDumNfDfx_iOlr5W48lZA',
  W03: '1syxvPHOMOtIVICVcG1ZyscOJ-Lih_rPEiYZRsPTN0y8',
  W05: '1KMUZGkfLrdkJh5-ECuzDbHRClatykFBlFIOZKqqirY8',
  W07: '1-yUL4N6UPuaUbHua0rHew3HvwqqXCvQ0cYDuMLcN-aE',
};

const RACES = [
  { key: 'all',     csv: 'All',     label_en: 'All',     label_zh: '总计'   },
  { key: 'chinese', csv: 'Chinese', label_en: 'Chinese', label_zh: '华族'   },
  { key: 'malay',   csv: 'Malay',   label_en: 'Malay',   label_zh: '马来族' },
  // Sheet uses "India" without 'n' in some rows; we accept either.
  { key: 'indian',  csv: 'India',   label_en: 'Indian',  label_zh: '印度族' },
  { key: 'others',  csv: 'Others',  label_en: 'Others',  label_zh: '其他'   },
];

// metric label as it appears in CSV col 1, paired with the key we use in JSON output.
const METRIC_DEFS = [
  { csv: 'Walk-in',             key: 'walkin'   },
  { csv: 'Purchase',            key: 'purchase' },
  { csv: 'Amount',              key: 'amount'   },
  { csv: 'Average Basket Size', key: 'basket'   },
  { csv: 'Closing Rate',        key: 'cr'       },
];
const METRICS_ORDER = METRIC_DEFS.map(m => m.csv); // backwards-compat export

// ── CSV parser (RFC-ish, handles "1,234" quoted thousands) ──
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  return text.replace(/\r/g, '').split('\n').map(parseCsvLine);
}

function parseNum(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (s === '' || s === '#DIV/0!' || s === '#N/A' || s === '-') return null;
  const isPct = s.endsWith('%');
  if (isPct) s = s.slice(0, -1);
  s = s.replace(/,/g, '');
  const v = parseFloat(s);
  if (isNaN(v)) return null;
  return isPct ? v / 100 : v;
}

// Parse one branch CSV → { months: [...], races: { key: { walkin:[12], purchase:[12], amount:[12], basket:[12], cr:[12] } } }
function parseBranchCsv(text, branchCode) {
  const grid = parseCsv(text);
  if (!grid.length) throw new Error(`empty CSV for ${branchCode}`);
  // Header row may not be at row 0 if there's a title row; we hunt for the row that
  // starts ",,All,Jan,..." pattern.
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(5, grid.length); i++) {
    const r = grid[i];
    if (r.length >= 15 && r[2] === 'All' && r[3] === 'Jan' && r[14] === 'Dec') { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) throw new Error(`header row "All,Jan..Dec" not found in ${branchCode}`);

  const races = {};
  let r = hdrIdx + 1;
  for (const race of RACES) {
    const grp = {};
    for (let m = 0; m < METRIC_DEFS.length; m++) {
      const def = METRIC_DEFS[m];
      // Allow the row pointer to scan forward up to 2 lines to tolerate odd
      // label drift ("Average Basket Size Per Cust  (2024 / 345.96)" or extra blanks).
      let row = null;
      for (let look = 0; look < 3 && r < grid.length; look++) {
        const cand = grid[r];
        const lbl = ((cand && cand[1]) || '').trim().toLowerCase();
        if (lbl.startsWith(def.csv.toLowerCase().slice(0, 7))) { row = cand; r++; break; }
        r++;
      }
      const months = [];
      if (row) {
        for (let mi = 3; mi <= 14; mi++) months.push(parseNum(row[mi]));
      } else {
        for (let mi = 0; mi < 12; mi++) months.push(null);
      }
      grp[def.key] = months;
    }
    races[race.key] = grp;
  }
  return { races };
}

async function fetchOneBranch(code, id) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return { code, ok: false, error: `HTTP ${r.status}` };
    const text = await r.text();
    if (text.startsWith('<') || /You need access|ServiceLogin/i.test(text)) {
      return { code, ok: false, error: 'sheet not link-shared (login wall)' };
    }
    const parsed = parseBranchCsv(text, code);
    return { code, ok: true, parsed, bytes: text.length };
  } catch (e) {
    return { code, ok: false, error: e.message };
  }
}

// Pick latest 3 months that have non-null walk-in across the 5 branches' "All" race row.
function pickLatestWindow(byBranch, year) {
  // build month-totals across branches for walk-in
  const totals = new Array(12).fill(0);
  let lastIdx = -1;
  for (let m = 0; m < 12; m++) {
    let sum = 0, any = false;
    for (const b of Object.keys(byBranch)) {
      const wi = byBranch[b]?.parsed?.races?.all?.walkin?.[m];
      if (wi != null && wi > 0) { sum += wi; any = true; }
    }
    totals[m] = sum;
    if (any) lastIdx = m;
  }
  if (lastIdx < 0) lastIdx = (new Date()).getMonth(); // fallback: current month
  const start = Math.max(0, lastIdx - 2);
  const idx = [];
  for (let i = start; i <= lastIdx; i++) idx.push(i);
  // pad to 3 if at year-start
  while (idx.length < 3 && idx[0] > 0) idx.unshift(idx[0] - 1);
  while (idx.length < 3 && idx[idx.length - 1] < 11) idx.push(idx[idx.length - 1] + 1);
  return { month_idx: idx.map(i => i + 1), months: idx.map(i => `${year}-${String(i + 1).padStart(2, '0')}`) };
}

function sumCols(arrays, idxs) {
  return idxs.map(i => {
    let sum = 0, any = false;
    for (const a of arrays) {
      const v = a?.[i];
      if (v != null) { sum += v; any = true; }
    }
    return any ? Math.round(sum * 100) / 100 : null;
  });
}

function buildResponse(byBranch) {
  const year = new Date().getFullYear();
  const { month_idx, months } = pickLatestWindow(byBranch, year);
  const branches = Object.keys(byBranch).filter(b => byBranch[b].ok);

  // Per-race totals across all branches for the 3-month window
  const races = RACES.filter(r => r.key !== 'all').map(race => {
    const walkin   = sumCols(branches.map(b => byBranch[b].parsed.races[race.key].walkin),  month_idx.map(m => m - 1));
    const purchase = sumCols(branches.map(b => byBranch[b].parsed.races[race.key].purchase), month_idx.map(m => m - 1));
    const amount   = sumCols(branches.map(b => byBranch[b].parsed.races[race.key].amount),  month_idx.map(m => m - 1));
    // basket = amount / purchase per month  (re-derive from sums; ignore per-branch averages)
    const basket = walkin.map((_, i) => (purchase[i] && amount[i]) ? Math.round((amount[i] / purchase[i]) * 100) / 100 : null);
    // cr = purchase / walkin per month
    const cr     = walkin.map((_, i) => (walkin[i] && purchase[i]) ? Math.round((purchase[i] / walkin[i]) * 10000) / 10000 : null);
    return { key: race.key, label_en: race.label_en, label_zh: race.label_zh, walkin, purchase, amount, basket, cr };
  });

  // Totals across races (sum of races for additive metrics; weighted from totals for ratios)
  const totWalkin   = month_idx.map((_, i) => races.reduce((s, r) => s + (r.walkin[i] || 0),   0) || null);
  const totPurchase = month_idx.map((_, i) => races.reduce((s, r) => s + (r.purchase[i] || 0), 0) || null);
  const totAmount   = month_idx.map((_, i) => races.reduce((s, r) => s + (r.amount[i] || 0),   0) || null);
  const totBasket = totPurchase.map((p, i) => (p && totAmount[i]) ? Math.round((totAmount[i] / p) * 100) / 100 : null);
  const totCr     = totWalkin.map((w, i) => (w && totPurchase[i]) ? Math.round((totPurchase[i] / w) * 10000) / 10000 : null);

  // Per-branch single-number summary across the 3-month window (using "All" race row)
  const by_branch = {};
  for (const b of branches) {
    const all = byBranch[b].parsed.races.all;
    const walkin   = month_idx.reduce((s, m) => s + (all.walkin[m - 1]   || 0), 0);
    const purchase = month_idx.reduce((s, m) => s + (all.purchase[m - 1] || 0), 0);
    const amount   = month_idx.reduce((s, m) => s + (all.amount[m - 1]   || 0), 0);
    by_branch[b] = {
      walkin,
      purchase,
      amount: Math.round(amount * 100) / 100,
      basket: purchase ? Math.round((amount / purchase) * 100) / 100 : null,
      cr:     walkin   ? Math.round((purchase / walkin) * 10000) / 10000 : null,
    };
  }

  // branches_full — keep raw 12-month detail for any future drill-down
  const branches_full = {};
  for (const b of branches) branches_full[b] = byBranch[b].parsed;

  // diagnostics — useful to debug "why is W05 missing"
  const diagnostics = {};
  for (const b of Object.keys(byBranch)) {
    diagnostics[b] = byBranch[b].ok
      ? { ok: true, bytes: byBranch[b].bytes }
      : { ok: false, error: byBranch[b].error };
  }

  return {
    ok: true,
    fetched_at: new Date().toISOString(),
    year,
    months,
    month_idx,
    races,
    totals: { walkin: totWalkin, purchase: totPurchase, amount: totAmount, basket: totBasket, cr: totCr },
    by_branch,
    branches_full,
    diagnostics,
    note_en: `Live walk-in (${months[0]} to ${months[months.length - 1]}) — pulled from 5 W0X Customer Floatation Sheets at fetched_at.`,
    note_zh: `实时进店数据(${months[0]} 至 ${months[months.length - 1]})— 来自 5 家分店 Customer Floatation Sheet。`,
    source: 'live:google-sheets',
  };
}

export default async function handler(req, res) {
  // CORS — same as proxy.js, this gets hit from the browser.
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  try {
    const results = await Promise.all(
      Object.entries(SHEETS).map(([code, id]) => fetchOneBranch(code, id))
    );
    const byBranch = {};
    for (const r of results) byBranch[r.code] = r;

    const okBranches = results.filter(r => r.ok);
    if (okBranches.length === 0) {
      const errs = {};
      for (const r of results) errs[r.code] = r.error;
      res.status(502).json({ ok: false, error: 'No floatation sheet was reachable', diagnostics: errs });
      return;
    }

    const payload = buildResponse(byBranch);
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, where: 'floatation handler' });
  }
}

// Exported for unit testing in Node
export const __test = { parseBranchCsv, parseNum, parseCsv, buildResponse, RACES, METRICS_ORDER };
