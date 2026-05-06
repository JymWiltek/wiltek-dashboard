// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Live Sales endpoint
//
// V1 第二刀 (2026-05-06): replaces the xlsx-build path for the Sales view.
// V1 第三刀 (2026-05-06 night): pulls TWO tabs from the Sales workbook —
//   1. Default tab  (MONTH × MAIN GROUP × AMT PO × AMT GRN)  — kept as-is
//      for legacy consumers (purchasing-by-group analytics).
//   2. "Raw sale"  (Month × Code × Branch × Qty × Amount)    — new source-of-
//      truth for the Sales dashboard. Per-branch per-month TOTAL Amount,
//      matches what Jym sees in the Sheet status bar (filter Mar-26 →
//      RM 372,608.31). The CustomerBuy-derived sales_by_branch_month was
//      a SUBSET (members only); switching to Raw sale fixes that.
//
// Sheet (link-shared, public read):
//   1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II
//   Default tab: PO/GRN aggregates (~465 rows)
//   "Raw sale" tab: per-transaction sale rows (~58k rows, Jan-23 .. current)
//
// No server cache — caller adds ?t=<ts> to bust browser cache.
// ═══════════════════════════════════════════════════════════════════════

const SHEET_ID = '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
// Raw sale tab — gviz CSV export by sheet name (handles tabs the default
// /export endpoint won't reach). URL-encoded "Raw sale" → "Raw%20sale".
const RAW_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Raw%20sale`;
// Active branches for the dashboard rollup. W11 + WCO appear in Raw sale
// (RM 29k + RM 52 in Mar-26) but the executive view scopes to the 5
// retail stores. We expose all branches in the response so the frontend
// can decide which to display.
const ACTIVE_BRANCHES = ['W01', 'W02', 'W03', 'W05', 'W07'];

// CSV parser — handles "1,122.00" quoted thousands.
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
function parseCsv(text) {
  return text.replace(/\r/g, '').split('\n').filter(l => l.length).map(parseCsvLine);
}
function parseNum(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (s === '' || s === '-' || s === '#N/A' || s === '#DIV/0!') return 0;
  s = s.replace(/,/g, '');
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

const MON_TO_NUM = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function monthLabelToYm(label) {
  // "Mar-26" → "2026-03"
  if (!label) return null;
  const m = String(label).trim().match(/^([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const mm = MON_TO_NUM[m[1].toLowerCase()];
  if (!mm) return null;
  let yy = parseInt(m[2], 10);
  if (yy < 100) yy = 2000 + yy;
  return `${yy}-${String(mm).padStart(2,'0')}`;
}

// Parse the "Raw sale" tab CSV → per-branch per-month Amount aggregate.
// Columns:  Month | Code | Branch | Qty | Amount (RM)
// Returns:  { sales_by_branch_month: { 'W01': { '2026-03': 55491, ... }, ... },
//             months_seen, branches_seen, n_rows }
function buildRawSaleAggregates(text) {
  const grid = parseCsv(text);
  if (!grid.length) return { sales_by_branch_month: {}, months_seen: [], branches_seen: [], n_rows: 0 };
  // Header check (gviz wraps each cell in quotes, so case/spacing flexible)
  const hdr = grid[0].map(s => String(s||'').trim().toLowerCase());
  if (!hdr.includes('month') || !hdr.includes('branch')) {
    throw new Error(`Raw sale unexpected header: ${grid[0].slice(0,5).join('|')}`);
  }
  const I_MONTH  = hdr.indexOf('month');
  const I_BRANCH = hdr.indexOf('branch');
  // "Amount (RM)" or just "Amount"
  let I_AMT = hdr.findIndex(h => /^amount/.test(h));
  if (I_AMT < 0) I_AMT = 4;

  const sbm = {};
  const monthsSet = new Set();
  const branchesSet = new Set();
  let n = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || r.length < 3) continue;
    const ym = monthLabelToYm(r[I_MONTH]);
    if (!ym) continue;
    const br = String(r[I_BRANCH]||'').trim();
    if (!br) continue;
    const amt = parseNum(r[I_AMT]);
    if (!sbm[br]) sbm[br] = {};
    sbm[br][ym] = (sbm[br][ym] || 0) + amt;
    monthsSet.add(ym);
    branchesSet.add(br);
    n++;
  }
  // Round to whole ringgit
  for (const br of Object.keys(sbm)) {
    for (const ym of Object.keys(sbm[br])) {
      sbm[br][ym] = Math.round(sbm[br][ym]);
    }
  }
  return {
    sales_by_branch_month: sbm,
    months_seen: [...monthsSet].sort(),
    branches_seen: [...branchesSet].sort(),
    n_rows: n,
  };
}

function buildResponse(text) {
  const grid = parseCsv(text);
  if (!grid.length) throw new Error('empty CSV');
  // Header check
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  if (hdr[0] !== 'MONTH' || hdr[1] !== 'MAIN GROUP') {
    throw new Error(`unexpected header: ${hdr.slice(0,4).join('|')}`);
  }

  // Parse rows → matrix[ym][group] = { po, grn }
  const matrix = {};
  const monthsSet = new Set();
  const groupsSet = new Set();
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || r.length < 4) continue;
    const ym = monthLabelToYm(r[0]);
    if (!ym) continue;
    const grp = String(r[1]||'').trim();
    if (!grp) continue;
    const po  = parseNum(r[2]);
    const grn = parseNum(r[3]);
    if (!matrix[ym]) matrix[ym] = {};
    matrix[ym][grp] = { po, grn };
    monthsSet.add(ym);
    groupsSet.add(grp);
  }

  const months = [...monthsSet].sort();
  const groups = [...groupsSet].sort();

  // Per-month totals
  const by_month = {};
  for (const m of months) {
    let po = 0, grn = 0;
    for (const g of groups) {
      const c = matrix[m][g]; if (!c) continue;
      po += c.po; grn += c.grn;
    }
    by_month[m] = { po: Math.round(po*100)/100, grn: Math.round(grn*100)/100 };
  }

  // Per-group totals (across all months)
  const by_group = {};
  for (const g of groups) {
    let po = 0, grn = 0;
    for (const m of months) {
      const c = matrix[m][g]; if (!c) continue;
      po += c.po; grn += c.grn;
    }
    by_group[g] = { po: Math.round(po*100)/100, grn: Math.round(grn*100)/100 };
  }

  // Latest month with non-zero data
  let latest_month = months[months.length - 1] || null;
  for (let i = months.length - 1; i >= 0; i--) {
    const t = by_month[months[i]];
    if (t && (t.po > 0 || t.grn > 0)) { latest_month = months[i]; break; }
  }

  return {
    ok: true,
    fetched_at: new Date().toISOString(),
    source: 'live:google-sheets',
    sheet_id: SHEET_ID,
    months,
    groups,
    matrix,
    by_month,
    by_group,
    latest_month,
    rows_n: grid.length - 1,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  try {
    // Fetch both tabs in parallel — Raw sale tab is ~3MB, default tab ~25KB.
    const [rDefault, rRaw] = await Promise.all([
      fetch(CSV_URL,     { redirect: 'follow' }),
      fetch(RAW_CSV_URL, { redirect: 'follow' }),
    ]);
    if (!rDefault.ok) {
      res.status(502).json({ ok: false, error: `upstream HTTP ${rDefault.status}`, sheet_id: SHEET_ID });
      return;
    }
    const text = await rDefault.text();
    if (text.startsWith('<') || /You need access|ServiceLogin/i.test(text)) {
      res.status(502).json({ ok: false, error: 'sheet not link-shared (login wall)', sheet_id: SHEET_ID });
      return;
    }
    const payload = buildResponse(text);

    // Raw sale tab — graceful degrade if it's missing / locked / down
    let raw = { sales_by_branch_month: {}, months_seen: [], branches_seen: [], n_rows: 0, _raw_ok: false, _raw_error: null };
    if (rRaw.ok) {
      try {
        const rawText = await rRaw.text();
        if (!rawText.startsWith('<') && !/You need access|ServiceLogin/i.test(rawText)) {
          const a = buildRawSaleAggregates(rawText);
          raw = { ...a, _raw_ok: true, _raw_error: null, active_branches: ACTIVE_BRANCHES };
        } else {
          raw._raw_error = 'login wall';
        }
      } catch (e) {
        raw._raw_error = e.message;
      }
    } else {
      raw._raw_error = `upstream HTTP ${rRaw.status}`;
    }

    res.status(200).json({ ...payload, ...raw, active_branches: ACTIVE_BRANCHES });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, where: 'sales handler' });
  }
}

// Exported for unit tests
export const __test = { parseCsv, parseNum, monthLabelToYm, buildResponse, buildRawSaleAggregates };
