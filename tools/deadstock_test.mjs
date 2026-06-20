#!/usr/bin/env node
/* ============================================================================
 * tools/deadstock_test.mjs — gate for the dead-stock handler's math.
 * ----------------------------------------------------------------------------
 * The deployed endpoint once returned RM 284,341 (2.8× inflated) because its
 * paginated fetch had no stable ORDER → rows duplicated across pages, and the
 * SKU count was rows, not DISTINCT item_code. This test pins the reconciliation
 * INVARIANTS on the pure core (computeDeadstock) so the endpoint can never
 * silently diverge from the canonical prod definition again:
 *   - a duplicate (store,item_code) row must NOT double-count value
 *   - dead_sku = DISTINCT item_code, never row count
 *   - a dead SKU with amount=0 still counts toward dead_sku (matches prod's
 *     count(DISTINCT item_code) which has no amount filter)
 *   - warehouse codes are a SEPARATE bucket, never live
 *
 * CANONICAL prod SQL the handler must equal (run on prod to reconcile live):
 *   WITH snap AS (SELECT max(snapshot_date) d FROM inventory_snapshots WHERE is_synthetic=false),
 *        ls AS (SELECT item_code, last_sale_date FROM v_item_last_sale)
 *   SELECT round(sum(i.amount)) dead_rm, count(DISTINCT i.item_code) dead_sku
 *   FROM inventory_snapshots i LEFT JOIN ls USING (item_code)
 *   WHERE i.snapshot_date=(SELECT d FROM snap) AND i.store IN ('W01','W02','W03','W05','W07')
 *     AND (ls.last_sale_date IS NULL OR ls.last_sale_date < (SELECT d FROM snap) - INTERVAL '365 days');
 *   → 102,182 / 230 (verified on prod 2026-06-20).
 *
 * 跑法: node tools/deadstock_test.mjs   (exit code = number of failed asserts)
 * ========================================================================== */
import { computeDeadstock } from '../lib/deadstock.mjs';

let fails = 0;
const eq = (label, got, want) => {
  if (got === want) { console.log(`  ✓ ${label} = ${got}`); }
  else { fails++; console.error(`  ✗ ${label}: got ${got}, want ${want}`); }
};

const snap = '2026-05-31';
const inv = [
  { id: 1, store: 'W01', item_code: 'A', qty: 2, amount: 100 },  // dead (live)
  { id: 2, store: 'W02', item_code: 'A', qty: 1, amount: 50 },   // SAME SKU, 2nd live store
  { id: 2, store: 'W02', item_code: 'A', qty: 1, amount: 50 },   // DUPLICATE (pagination overlap) — must not double-count
  { id: 3, store: 'W01', item_code: 'B', qty: 1, amount: 0 },    // dead, 0 value — must still count toward dead_sku
  { id: 4, store: 'W01', item_code: 'C', qty: 1, amount: 200 },  // ACTIVE — sold recently
  { id: 5, store: 'WLO', item_code: 'D', qty: 1, amount: 80 },   // dead, WAREHOUSE (not live)
];
const lastSale = { C: '2026-05-01' /* recent → Active */ };  // A,B,D absent → never sold → Dead

const out = computeDeadstock(inv, lastSale, snap, 0.5);
console.log('=== deadstock invariants ===');
eq('headline.dead_rm (no dup double-count: 100+50+0)', out.headline.dead_rm, 150);
eq('headline.dead_sku (DISTINCT item_code A,B — not 3 rows)', out.headline.dead_sku, 2);
eq('cash_release @50%', out.headline.cash_release, 75);
eq('warehouse_rm (separate bucket)', out.warehouse_rm, 80);
eq('warehouse_sku', out.warehouse_sku, 1);
eq('active SKU C excluded from live dead', out.live.some(d => d.item_code === 'C'), false);
eq('0-value SKU B present in live dead', out.live.some(d => d.item_code === 'B'), true);
eq('duplicate A@W02 collapsed (live dead rows = 3: A@W01,A@W02,B@W01)', out.live.length, 3);

console.log(fails ? `\n✗ FAIL — ${fails} invariant(s) broken` : '\n✓ PASS — dead-stock math reconciles to the canonical definition');
process.exit(fails ? 1 : 0);
