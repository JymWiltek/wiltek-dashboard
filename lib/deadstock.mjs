// Dead-stock classification core — PURE, dependency-free, so it is unit-testable
// without the Supabase client. Shared by api/kpi.js (view=deadstock) and
// tools/deadstock_test.mjs. Must equal this CANONICAL prod SQL line-for-line:
//   WITH snap AS (SELECT max(snapshot_date) d FROM inventory_snapshots WHERE is_synthetic=false),
//        ls AS (SELECT item_code, last_sale_date FROM v_item_last_sale)
//   SELECT round(sum(i.amount)) dead_rm, count(DISTINCT i.item_code) dead_sku
//   FROM inventory_snapshots i LEFT JOIN ls USING (item_code)
//   WHERE i.snapshot_date=(SELECT d FROM snap) AND i.store IN ('W01','W02','W03','W05','W07')
//     AND (ls.last_sale_date IS NULL OR ls.last_sale_date < (SELECT d FROM snap) - INTERVAL '365 days');
//   → 102,182 / 230 (verified on prod 2026-06-20).
export const DEADSTOCK_LIVE = ['W01', 'W02', 'W03', 'W05', 'W07'];

export function computeDeadstock(invRows, lastSaleMap, snapDate, recovery) {
  const snapMs = new Date(snapDate + 'T00:00:00Z').getTime();
  const DAY = 86400000;
  // Dedup by (store,item_code) — the snapshot's unique key is
  // (snapshot_date,store,item_code), so this is a no-op on clean data but is a
  // hard guard against any paginated-fetch overlap double-counting amounts
  // (that overlap was the 2.8× inflation bug).
  const seen = new Map();
  for (const r of invRows) {
    const key = r.store + ' ' + r.item_code;
    if (!seen.has(key)) seen.set(key, r);
  }
  const dead = [];
  for (const r of seen.values()) {
    const ls = lastSaleMap[r.item_code] || null;
    const days = ls ? Math.round((snapMs - new Date(ls + 'T00:00:00Z').getTime()) / DAY) : null;
    if (!(days == null || days > 365)) continue;   // Dead = never sold OR > 365d
    dead.push({
      item_code: r.item_code, store: r.store, qty: +r.qty || 0, amount: Math.round(+r.amount || 0),
      last_sold: ls, days_since: days,
      bucket: days == null ? '365+' : days <= 90 ? '0-90' : days <= 180 ? '90-180' : days <= 365 ? '180-365' : '365+',
      is_live: DEADSTOCK_LIVE.includes(r.store),
    });
  }
  dead.sort((a, b) => b.amount - a.amount);
  const live = dead.filter(d => d.is_live);
  const wh = dead.filter(d => !d.is_live);
  const rm = (a) => a.reduce((s, d) => s + d.amount, 0);
  const sku = (a) => new Set(a.map(d => d.item_code)).size;   // DISTINCT item_code, not rows
  const deadRm = rm(live);
  return {
    snapshot_date: snapDate, recovery_rate: recovery,
    headline: { dead_rm: deadRm, dead_sku: sku(live), cash_release: Math.round(deadRm * recovery) },
    live, warehouse: wh, warehouse_rm: rm(wh), warehouse_sku: sku(wh),
  };
}
