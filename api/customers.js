// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Live Customers (Customer Buy V3) endpoint
//
// V1 第二刀 (2026-05-06): replaces the xlsx-build path for Customers /
// Customer-Insights views. Reads the public Google Sheet "Customer Buy"
// (anyone-with-link viewer) and replicates the exact derivations that
// tools/build-today.py produces for assets/customers-data.js +
// assets/today-data.js (churn block).
//
// Sheet (link-shared, public read):
//   1AjYt9plWymcQMeW4tIZ6A_3QdDlUB_ShreX-d4_mA8s
//
// CSV columns:
//   MONTH, BILL, Item Code, Branches, Customer Name, Member Code, QTY, AMT,
//   CUST TYPE, Date Enrolled, Loyalty, Main Group, Sub group
//
// Approx 70K rows. Snapshot-relative windows (1m / 3m / 6m / 12m) are
// computed from the requested ?month=YYYY-MM (default = latest with data).
//
// Returns shape:
//   {
//     ok, fetched_at, source, snapshot,
//     summary,                       // 12m window legacy fields
//     summary_by_window,             // {1m,3m,6m,12m}
//     buckets_by_window,             // {1m:[{key,n,amt,aov,repeat_pct,n_active}...],...}
//     cross_by_window,               // {1m:{type:{bucket:{n,amt}}}, ...}
//     top100,                        // top by ltm_amt
//     windows:["1m","3m","6m","12m"],
//     types:["Walk-in","Contractor","Interior Designer","Other"],
//     churn: { summary, rows },
//     diagnostics
//   }
// ═══════════════════════════════════════════════════════════════════════

const SHEET_ID = '1AjYt9plWymcQMeW4tIZ6A_3QdDlUB_ShreX-d4_mA8s';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

const ACTIVE_BRANCHES = new Set(['W01', 'W02', 'W03', 'W05', 'W07']);
const BUCKETS = ['<1y', '1-5y', '5-8y', '8y+'];
const TYPES   = ['Walk-in', 'Contractor', 'Interior Designer', 'Other'];
const WINDOWS = ['1m', '3m', '6m', '12m'];

const CT_LABEL = { N: 'Walk-in', C: 'Contractor', D: 'Interior Designer' };
function ctNorm(raw) {
  if (raw == null) return 'Other';
  const s = String(raw).trim().toUpperCase();
  return CT_LABEL[s] || 'Other';
}

// ── CSV parser ──
function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
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
function parseNum(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (s === '' || s === '-') return 0;
  s = s.replace(/,/g, '');
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

// "Mar-26" → {y:2026, m:3}
const MON_TO_NUM = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseMonthYY(label) {
  if (!label) return null;
  const m = String(label).trim().match(/^([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const mm = MON_TO_NUM[m[1].toLowerCase()];
  if (!mm) return null;
  let yy = parseInt(m[2], 10);
  if (yy < 100) yy = 2000 + yy;
  return { y: yy, m: mm };
}

// "7/2/2020" → {y,m,d} (locale-y M/D/Y as seen in CSV)
// Also accepts ISO "2020-07-02".
function parseEnrolDate(label) {
  if (!label) return null;
  const s = String(label).trim();
  if (!s) return null;
  // ISO?
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  // M/D/YYYY?
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y = 2000 + y;
    return { y, m: +m[1], d: +m[2] };
  }
  return null;
}

function ymKey(y, m) { return y * 12 + (m - 1); }
function ymStr(ym)   { return `${String(ym.y).padStart(4,'0')}-${String(ym.m).padStart(2,'0')}`; }

function ageBucket(years) {
  if (years < 1) return '<1y';
  if (years < 5) return '1-5y';
  if (years < 8) return '5-8y';
  return '8y+';
}

// shift snapshot ym by n months back
function shiftYm(ym, n) {
  const total = ym.y * 12 + (ym.m - 1) - n;
  return { y: Math.floor(total / 12), m: (total % 12 + 12) % 12 + 1 };
}

// Derive everything from raw rows. snapshotYm = {y,m}.
function buildPayload(rows, snapshotYm) {
  // cutoffs: M3 means "month >= NOW - 2", i.e. last 3 months including snapshot.
  const k_now  = ymKey(snapshotYm.y, snapshotYm.m);
  const k_ltm  = k_now - 11;   // last 12 months incl snapshot
  const k_m6   = k_now - 5;
  const k_m3   = k_now - 2;
  const k_m1   = k_now;

  // ── Per-branch per-month sales (V1 第二刀 验收 fix, 2026-05-06) ──
  // Source-of-truth for the Sales dashboard cards/chart. Selected SNAPSHOT
  // month → use sales_by_branch_month[BR][SNAPSHOT] for that one month only.
  // No "last 3m", no MoM, no estimates — Jym's mandate is single-month isolation.
  const sales_by_branch_month = {};
  for (const r of rows) {
    if (!r.branch) continue;
    if (!ACTIVE_BRANCHES.has(r.branch)) continue;
    if (!r.amt) continue;
    const ym = ymStr(r.ym);
    if (!sales_by_branch_month[r.branch]) sales_by_branch_month[r.branch] = {};
    sales_by_branch_month[r.branch][ym] = (sales_by_branch_month[r.branch][ym] || 0) + r.amt;
  }
  for (const br of Object.keys(sales_by_branch_month)) {
    for (const ym of Object.keys(sales_by_branch_month[br])) {
      sales_by_branch_month[br][ym] = Math.round(sales_by_branch_month[br][ym]);
    }
  }

  // ── Member master pass ──
  const mem = new Map();
  for (const r of rows) {
    const mc = r.mc; if (!mc) continue;
    const ymk = ymKey(r.ym.y, r.ym.m);

    let d = mem.get(mc);
    if (!d) {
      d = {
        last: null, first: null, amt: 0,
        visits: new Set(), name: '', branches: {}, loy: '',
        enrol: null, cust_type: '',
        ltm_amt: 0, ltm_visits: new Set(),
        m6_amt:  0, m6_visits:  new Set(),
        m3_amt:  0, m3_visits:  new Set(),
        m1_amt:  0, m1_visits:  new Set(),
      };
      mem.set(mc, d);
    }

    if (d.last == null || ymk > d.last) d.last = ymk;
    if (d.first == null || ymk < d.first) d.first = ymk;
    d.amt += r.amt;
    if (r.bill) d.visits.add(r.bill);
    if (!d.name && r.name) d.name = r.name;
    if (r.branch) d.branches[r.branch] = (d.branches[r.branch] || 0) + r.amt;
    if (r.loy && !d.loy) d.loy = r.loy;
    if (r.enrol && (d.enrol == null || ymKey(r.enrol.y, r.enrol.m) < ymKey(d.enrol.y, d.enrol.m))) {
      if (r.enrol.y >= 1990 && r.enrol.y <= snapshotYm.y) d.enrol = r.enrol;
    }
    if (r.ct && !d.cust_type) d.cust_type = ctNorm(r.ct);

    if (ymk >= k_ltm) { d.ltm_amt += r.amt; if (r.bill) d.ltm_visits.add(r.bill); }
    if (ymk >= k_m6)  { d.m6_amt  += r.amt; if (r.bill) d.m6_visits.add(r.bill);  }
    if (ymk >= k_m3)  { d.m3_amt  += r.amt; if (r.bill) d.m3_visits.add(r.bill);  }
    if (ymk >= k_m1)  { d.m1_amt  += r.amt; if (r.bill) d.m1_visits.add(r.bill);  }
  }

  // ── Churn (D1) ──
  // Members whose last purchase is older than 5 months from snapshot AND lifetime amt >= 500 AND >=2 visits
  const k_churn = k_now - 5;
  const churned = [];
  for (const [mc, d] of mem) {
    if (d.last == null) continue;
    if (d.last >= k_churn) continue;
    if (d.amt < 500) continue;
    if (d.visits.size < 2) continue;
    const branchEntries = Object.entries(d.branches);
    if (!branchEntries.length) continue;
    let primary = branchEntries[0][0], best = -Infinity;
    for (const [b, v] of branchEntries) if (v > best) { primary = b; best = v; }
    const months_ago = k_now - d.last;
    const lastY = Math.floor(d.last / 12), lastM = (d.last % 12) + 1;
    churned.push({
      mc: String(mc),
      name: (d.name || '').slice(0, 40) || String(mc),
      last: ymStr({ y: lastY, m: lastM }),
      months_ago,
      amount: Math.round(d.amt),
      visits: d.visits.size,
      loyalty: d.loy || '',
      branch: primary,
      cust_type: d.cust_type || 'Other',
    });
  }
  churned.sort((a, b) => b.amount - a.amount);
  const TIER_HIGH = 1000;
  const high_value_churn = churned.filter(c => c.amount >= TIER_HIGH);
  const total_high_value_lifetime = high_value_churn.reduce((s, c) => s + c.amount, 0);

  // ── Customer Insights (V1 第3刀) RFM ──
  const NOW_DT = new Date(Date.UTC(snapshotYm.y, snapshotYm.m - 1, 28)); // last day of snapshot month (close enough)
  // Actually use end-of-month:
  const eom = new Date(Date.UTC(snapshotYm.y, snapshotYm.m, 0)); // day 0 of next month = last day this month
  const ci_rows = [];
  for (const [mc, d] of mem) {
    if (d.last == null) continue;
    const branchEntries = Object.entries(d.branches);
    if (!branchEntries.length) continue;
    let primary = branchEntries[0][0], best = -Infinity;
    for (const [b, v] of branchEntries) if (v > best) { primary = b; best = v; }
    if (!ACTIVE_BRANCHES.has(primary)) continue;
    if (!d.enrol) continue;
    const enrolDt = new Date(Date.UTC(d.enrol.y, d.enrol.m - 1, d.enrol.d || 1));
    const years = (eom - enrolDt) / (1000 * 60 * 60 * 24 * 365.25);
    if (years < 0) continue;
    const bucket = ageBucket(years);
    const lastY = Math.floor(d.last / 12), lastM = (d.last % 12) + 1;
    ci_rows.push({
      mc: String(mc),
      name: (d.name || '').slice(0, 40) || String(mc),
      branch: primary,
      cust_type: d.cust_type || 'Other',
      enrol: `${String(d.enrol.y).padStart(4,'0')}-${String(d.enrol.m).padStart(2,'0')}-${String(d.enrol.d||1).padStart(2,'0')}`,
      age_years: Math.round(years * 10) / 10,
      age_bucket: bucket,
      ltm_amt: Math.round(d.ltm_amt),
      ltm_visits: d.ltm_visits.size,
      m6_amt: Math.round(d.m6_amt),
      m6_visits: d.m6_visits.size,
      m3_amt: Math.round(d.m3_amt),
      m3_visits: d.m3_visits.size,
      m1_amt: Math.round(d.m1_amt),
      m1_visits: d.m1_visits.size,
      lifetime_amt: Math.round(d.amt),
      last: ymStr({ y: lastY, m: lastM }),
    });
  }

  // ── Bucket aggregates per window ──
  const amtField = w => ({'1m':'m1_amt','3m':'m3_amt','6m':'m6_amt','12m':'ltm_amt'})[w];
  const visField = w => ({'1m':'m1_visits','3m':'m3_visits','6m':'m6_visits','12m':'ltm_visits'})[w];

  const bucket_agg_by_window = {};
  for (const w of WINDOWS) {
    const af = amtField(w), vf = visField(w);
    const bagg = {};
    for (const b of BUCKETS) bagg[b] = { n: 0, amt: 0, visits: 0, n_repeat: 0, n_active: 0 };
    for (const r of ci_rows) {
      const cell = bagg[r.age_bucket]; if (!cell) continue;
      cell.n += 1;
      cell.amt += r[af];
      cell.visits += r[vf];
      if (r[vf] >= 1) cell.n_active += 1;
      if (r[vf] >= 2) cell.n_repeat += 1;
    }
    for (const b of BUCKETS) {
      const v = bagg[b];
      v.aov = v.visits ? Math.round(v.amt / v.visits) : 0;
      v.repeat_pct = v.n_active ? Math.round(1000 * v.n_repeat / v.n_active) / 10 : 0;
      v.amt = Math.round(v.amt);
    }
    bucket_agg_by_window[w] = bagg;
  }

  // ── Cross-table type × bucket per window ──
  const cross_by_window = {};
  for (const w of WINDOWS) {
    const af = amtField(w);
    const cr = {};
    for (const tp of TYPES) {
      cr[tp] = {};
      for (const b of BUCKETS) cr[tp][b] = { n: 0, amt: 0 };
    }
    for (const r of ci_rows) {
      const tp = TYPES.includes(r.cust_type) ? r.cust_type : 'Other';
      const cell = cr[tp][r.age_bucket]; if (!cell) continue;
      cell.n += 1;
      cell.amt += r[af];
    }
    for (const tp of TYPES) for (const b of BUCKETS) cr[tp][b].amt = Math.round(cr[tp][b].amt);
    cross_by_window[w] = cr;
  }

  // ── Top 100 by LTM ──
  const top100 = [...ci_rows].sort((a, b) => b.ltm_amt - a.ltm_amt).slice(0, 100);

  // ── Summary per window ──
  function summaryFor(w) {
    const af = amtField(w);
    const bagg = bucket_agg_by_window[w];
    const total_n = ci_rows.length;
    const n_5plus = bagg['5-8y'].n + bagg['8y+'].n;
    let total_amt = 0, amt_5plus = 0, n_active = 0;
    for (const r of ci_rows) {
      total_amt += r[af];
      if (r.age_bucket === '5-8y' || r.age_bucket === '8y+') amt_5plus += r[af];
      if (r[af] > 0) n_active += 1;
    }
    return {
      total_members: total_n,
      n_active,
      n_lt1:   bagg['<1y'].n,
      n_1_5:   bagg['1-5y'].n,
      n_5_8:   bagg['5-8y'].n,
      n_8plus: bagg['8y+'].n,
      amt_total: Math.round(total_amt),
      amt_lt1:   bagg['<1y'].amt,
      amt_1_5:   bagg['1-5y'].amt,
      amt_5_8:   bagg['5-8y'].amt,
      amt_8plus: bagg['8y+'].amt,
      pct_5plus_n:   total_n   ? Math.round(1000 * n_5plus / total_n) / 10   : 0,
      pct_5plus_amt: total_amt ? Math.round(1000 * amt_5plus / total_amt) / 10 : 0,
    };
  }
  const summary_by_window = {};
  for (const w of WINDOWS) summary_by_window[w] = summaryFor(w);
  const summary = { ...summary_by_window['12m'], snapshot: ymStr(snapshotYm) };

  // Convert buckets_by_window to array form (matches Python emit shape)
  const buckets_by_window_arr = {};
  for (const w of WINDOWS) {
    buckets_by_window_arr[w] = BUCKETS.map(b => {
      const v = bucket_agg_by_window[w][b];
      return { key: b, n: v.n, amt: v.amt, aov: v.aov, repeat_pct: v.repeat_pct, n_active: v.n_active };
    });
  }

  return {
    summary,
    summary_by_window,
    buckets_by_window: buckets_by_window_arr,
    cross_by_window,
    sales_by_branch_month,
    top100,
    windows: WINDOWS,
    types: TYPES,
    churn: {
      summary: {
        n_total: churned.length,
        n_high_value: high_value_churn.length,
        lifetime_rm: total_high_value_lifetime,
        cutoff_months: 6,
        high_value_threshold: TIER_HIGH,
      },
      rows: churned.slice(0, 500),
    },
    diagnostics: {
      n_rows: rows.length,
      n_members: mem.size,
      n_ci_rows: ci_rows.length,
      n_churn: churned.length,
      snapshot: ymStr(snapshotYm),
    },
  };
}

// Parse the raw CSV text → rows[] of normalized objects.
function parseCsvText(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  if (!lines.length) return { rows: [], months_seen: [] };
  const hdr = parseCsvLine(lines[0]).map(s => String(s||'').trim().toUpperCase());
  // Detect column indexes by header so we tolerate column reorder.
  const idx = {};
  for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;
  const I_MONTH = idx['MONTH']         ?? 0;
  const I_BILL  = idx['BILL']          ?? 1;
  const I_CODE  = idx['ITEM CODE']     ?? 2;
  const I_BR    = idx['BRANCHES']      ?? 3;
  const I_NAME  = idx['CUSTOMER NAME'] ?? 4;
  const I_MC    = idx['MEMBER CODE']   ?? 5;
  const I_QTY   = idx['QTY']           ?? 6;
  const I_AMT   = idx['AMT']           ?? 7;
  const I_CT    = idx['CUST TYPE']     ?? 8;
  const I_EN    = idx['DATE ENROLLED'] ?? 9;
  const I_LOY   = idx['LOYALTY']       ?? 10;

  const rows = [];
  const monthsSeen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]; if (!ln) continue;
    const r = parseCsvLine(ln);
    const ym = parseMonthYY(r[I_MONTH]);
    if (!ym) continue;
    const mc = String(r[I_MC]||'').trim();
    if (!mc) continue;
    rows.push({
      ym,
      bill: String(r[I_BILL]||'').trim(),
      branch: String(r[I_BR]||'').trim(),
      name: String(r[I_NAME]||'').trim(),
      mc,
      amt: parseNum(r[I_AMT]),
      ct: String(r[I_CT]||'').trim(),
      enrol: parseEnrolDate(r[I_EN]),
      loy: String(r[I_LOY]||'').trim(),
    });
    monthsSeen.add(ymStr(ym));
  }
  return { rows, months_seen: [...monthsSeen].sort() };
}

function pickSnapshot(monthsSeen, requested) {
  // requested is "YYYY-MM" or null
  if (requested && /^\d{4}-\d{2}$/.test(requested) && monthsSeen.includes(requested)) {
    const [y, m] = requested.split('-').map(s => parseInt(s, 10));
    return { y, m };
  }
  // default: latest month with data
  const last = monthsSeen[monthsSeen.length - 1];
  if (!last) return { y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() + 1 };
  const [y, m] = last.split('-').map(s => parseInt(s, 10));
  return { y, m };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  const requested = (req.query?.month || '').toString();

  try {
    const r = await fetch(CSV_URL, { redirect: 'follow' });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `upstream HTTP ${r.status}`, sheet_id: SHEET_ID });
      return;
    }
    const text = await r.text();
    if (text.startsWith('<') || /You need access|ServiceLogin/i.test(text)) {
      res.status(502).json({ ok: false, error: 'sheet not link-shared (login wall)', sheet_id: SHEET_ID });
      return;
    }
    const { rows, months_seen } = parseCsvText(text);
    const snapshot = pickSnapshot(months_seen, requested);
    const derived = buildPayload(rows, snapshot);

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'live:google-sheets',
      sheet_id: SHEET_ID,
      months_seen,
      snapshot: `${String(snapshot.y).padStart(4,'0')}-${String(snapshot.m).padStart(2,'0')}`,
      requested_month: requested || null,
      ...derived,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, where: 'customers handler' });
  }
}

// Exported for unit tests
export const __test = {
  parseCsvText, parseMonthYY, parseEnrolDate, ctNorm, ageBucket,
  shiftYm, ymKey, ymStr, buildPayload, pickSnapshot,
};
