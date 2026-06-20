#!/usr/bin/env node
/* ============================================================================
 * tools/deadstock_reconcile.mjs — LIVE gate: deployed endpoint == prod SQL.
 * ----------------------------------------------------------------------------
 * deadstock_test.mjs pins the pure math (credential-free, runs in CI). THIS
 * script closes the other half the user demanded: it fails if the DEPLOYED
 * /api/kpi?view=deadstock endpoint diverges from the canonical prod definition.
 *
 * It re-derives the ground truth INDEPENDENTLY — a second implementation of the
 * definition (NOT importing computeDeadstock), reading the same three prod
 * tables via the service-role client — then curls the live endpoint and asserts
 * the headline matches EXACTLY. Two independent implementations + the canonical
 * SQL all agreeing is the reconciliation.
 *
 * CANONICAL prod SQL it reproduces (verified on prod 2026-06-20 → 102,182 / 230):
 *   WITH snap AS (SELECT max(snapshot_date) d FROM inventory_snapshots WHERE is_synthetic=false),
 *        ls AS (SELECT item_code, last_sale_date FROM v_item_last_sale)
 *   SELECT round(sum(i.amount)) dead_rm, count(DISTINCT i.item_code) dead_sku
 *   FROM inventory_snapshots i LEFT JOIN ls USING (item_code)
 *   WHERE i.snapshot_date=(SELECT d FROM snap) AND i.store IN ('W01','W02','W03','W05','W07')
 *     AND (ls.last_sale_date IS NULL OR ls.last_sale_date < (SELECT d FROM snap) - INTERVAL '365 days');
 *
 * 跑法 (post-deploy, needs secrets):
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   WP_DEADSTOCK_URL='https://<deploy>/api/kpi?view=deadstock' WP_USER=<inventory-role-user> \
 *   node tools/deadstock_reconcile.mjs
 *   (exit 0 = endpoint reconciles to prod; exit 1 = drift; exit 2 = misconfig)
 *
 * NOTE: run this against the deployment that carries the fix. Against the
 * pre-fix prod it FAILS by ~2.8× — that is the gate correctly catching the
 * live bug, not a false negative.
 * ========================================================================== */
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, WP_DEADSTOCK_URL, WP_USER } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !WP_DEADSTOCK_URL || !WP_USER) {
  console.error('MISCONFIG: need SUPABASE_URL, SUPABASE_SERVICE_KEY, WP_DEADSTOCK_URL, WP_USER');
  process.exit(2);
}
const LIVE = ['W01', 'W02', 'W03', 'W05', 'W07'];
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// Paginate with a stable order — same discipline the handler now uses.
async function all(table, cols, orderCol, eq) {
  const out = []; let from = 0; const step = 1000;
  for (let p = 0; p < 40; p++) {
    let q = sb.from(table).select(cols).order(orderCol, { ascending: true }).range(from, from + step - 1);
    if (eq) q = q.eq(eq[0], eq[1]);
    const { data, error } = await q;
    if (error) { console.error('DB error on', table, error.message); process.exit(2); }
    if (!data || !data.length) break;
    out.push(...data); if (data.length < step) break; from += step;
  }
  return out;
}

// ── Independent canonical computation (a second implementation) ──────────────
const snapRow = await sb.from('inventory_snapshots').select('snapshot_date')
  .eq('is_synthetic', false).order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
const snap = snapRow.data?.snapshot_date;
if (!snap) { console.error('MISCONFIG: no real snapshot'); process.exit(2); }
const snapMs = new Date(snap + 'T00:00:00Z').getTime();
const cutoff = snapMs - 365 * 86400000;

const lastSale = {};
for (const r of await all('v_item_last_sale', 'item_code, last_sale_date', 'item_code')) {
  lastSale[r.item_code] = r.last_sale_date;
}
const seen = new Set();   // dedup (store,item_code) — defensive, PK should make it a no-op
let expRm = 0; const expSku = new Set();
for (const r of await all('inventory_snapshots', 'id, item_code, store, amount', 'id', ['snapshot_date', snap])) {
  if (!LIVE.includes(r.store)) continue;
  const key = r.store + '|' + r.item_code;
  if (seen.has(key)) continue;
  seen.add(key);
  const ls = lastSale[r.item_code] || null;
  const dead = !ls || new Date(ls + 'T00:00:00Z').getTime() < cutoff;
  if (!dead) continue;
  expRm += Math.round(+r.amount || 0);
  expSku.add(r.item_code);
}
const expected = { snapshot_date: snap, dead_rm: Math.round(expRm), dead_sku: expSku.size };

// ── Deployed endpoint ────────────────────────────────────────────────────────
const resp = await fetch(WP_DEADSTOCK_URL, { headers: { 'x-wp-user': WP_USER } });
if (!resp.ok) { console.error('ENDPOINT HTTP', resp.status); process.exit(1); }
const body = await resp.json();
if (body.degraded) { console.error('ENDPOINT degraded:', body.degraded_reason); process.exit(1); }
const got = { snapshot_date: body.snapshot_date, dead_rm: body.headline?.dead_rm, dead_sku: body.headline?.dead_sku };

// ── Reconcile ────────────────────────────────────────────────────────────────
let fails = 0;
const eq = (label, g, e) => {
  if (g === e) console.log(`  ✓ ${label}: ${g}`);
  else { fails++; console.error(`  ✗ ${label}: endpoint ${g} != prod ${e}`); }
};
console.log('=== deadstock endpoint vs prod reconcile ===');
eq('snapshot_date', got.snapshot_date, expected.snapshot_date);
eq('dead_rm', got.dead_rm, expected.dead_rm);
eq('dead_sku', got.dead_sku, expected.dead_sku);
console.log(fails
  ? `\n✗ FAIL — endpoint diverges from prod (${fails} field(s))`
  : `\n✓ PASS — endpoint == prod SQL (RM ${got.dead_rm} / ${got.dead_sku} SKU @ ${got.snapshot_date})`);
process.exit(fails ? 1 : 0);
