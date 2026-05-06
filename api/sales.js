// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal — Live Sales (PO + GRN by Month × Main Group) endpoint
//
// V1 第二刀 (2026-05-06): replaces the xlsx-build path for the Sales view.
// Reads the public Google Sheet "Sales/PO/Inventory" (anyone-with-link viewer)
// and parses the CSV export directly. Returns shape compatible with how
// the dashboard consumes /api/proxy?type=sales today, plus a normalized
// month-keyed matrix the frontend can pivot client-side.
//
// Sheet (link-shared, public read):
//   1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II
//
// CSV columns:  MONTH (e.g. "Mar-26"), MAIN GROUP, AMT PO, AMT GRN
// CSV size: ~465 rows covering Oct-23 .. Mar-26 (2.5+ years)
//
// No server cache — caller adds ?t=<ts> to bust browser cache.
// ═══════════════════════════════════════════════════════════════════════

const SHEET_ID = '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

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
    const payload = buildResponse(text);
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, where: 'sales handler' });
  }
}

// Exported for unit tests
export const __test = { parseCsv, parseNum, monthLabelToYm, buildResponse };
