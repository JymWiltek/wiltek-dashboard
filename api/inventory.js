// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Sprint 2 — /api/inventory thin wrapper over RPC.
//
// Sprint 1 version pulled inventory_snapshots (7,859), items (5,333),
// sales (60,410) into Node.js then computed clsV16 + totals + by_branch
// in JS — ~5-8s cold. Sprint 2 moves all aggregation into the
// inventory_payload(p_branch) Postgres RPC; this handler just forwards
// the JSON. Target: <2s cold.
//
// Response shape preserved exactly (renderInventoryDashboard / Today /
// V1.6 4-state classifier on frontend continue to work without changes).
//
// Sprint 5 P0 Stage 1: absorbed /api/inventory_dashboard to free a Vercel
// Hobby function slot (12-cap) for the new /api/kpi endpoint. Dispatch:
//   ?mode= (default) → inventory_payload (full row-level dashboard)
//   ?mode=dashboard            → inventory_dashboard_payload (top 4 KPIs)
//   ?mode=dashboard&section=alerts → inventory_alerts_payload (4 alert cards)
// vercel.json rewrites /api/inventory_dashboard → /api/inventory?mode=dashboard
// to keep existing frontend callsites in Wiltek_MASTER.html unchanged.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
function sb() {
  if (supabase) return supabase;
  if (!URL || !KEY) throw new Error('Supabase env vars missing');
  supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

async function loadSessionUser(username) {
  if (!username) return null;
  const { data, error } = await sb().from('users')
    .select('username, role, store, is_active')
    .eq('username', username).maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-user');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);

  const mode    = String(req.query?.mode || '').trim().toLowerCase();
  const section = String(req.query?.section || '').trim().toLowerCase();

  // Sprint 5 P0 Stage 1 — dashboard mode (was /api/inventory_dashboard).
  // Requires session (was 401 in the old handler); keep that contract.
  if (mode === 'dashboard') {
    if (!user) return res.status(401).json({ ok: false, error: 'no session' });
    // Bug 3 fix (2026-05-15): owner can pass ?branch=<X> to scope the
    // dashboard; manager pinned to own store regardless. Mirrors /api/kpi.
    const queryBranch = String(req.query?.branch || '').trim().toUpperCase();
    let p_branch;
    if (user.role === 'owner') {
      p_branch = queryBranch || null;
    } else {
      if (queryBranch && queryBranch !== user.store) {
        return res.status(403).json({ ok: false, error: 'branch not allowed for this user' });
      }
      p_branch = user.store;
    }
    const rpc = section === 'alerts' ? 'inventory_alerts_payload' : 'inventory_dashboard_payload';
    try {
      const { data, error } = await sb().rpc(rpc, { p_branch });
      if (error) {
        console.error(`[/api/inventory mode=dashboard section=${section}] RPC error:`, error);
        res.status(500).json({ ok: false, error: error.message });
        return;
      }
      // Stage C-synth (2026-05-16): surface inventory_snapshots.is_synthetic
      // so the frontend can flag the displayed snapshot as a synthetic
      // baseline (Notion SOP 3620a2d3110081bc8deef3944a4b8fe4). RPC doesn't
      // carry the flag — quick side select. Same query also yields the
      // 12-store total + by_branch sums (Stage C-12store fix: the legacy
      // inventory_dashboard_payload RPC only includes 5 active branches; we
      // override health.total_stock + add by_branch from the raw table so
      // the Inventory K1 card matches Sheet truth (~RM 1,105k for all 12).
      let is_synthetic = false;
      let synthetic_snapshot_date = null;
      let twelve_store_total = null;
      let twelve_store_by_branch = null;
      try {
        const snapDate = (data && data.snapshot_date) || (data && data.health && data.health.snap_date) || null;
        if (snapDate) {
          // is_synthetic probe (1 row, whole-table all-or-none).
          const { data: synRow } = await sb()
            .from('inventory_snapshots')
            .select('is_synthetic')
            .eq('snapshot_date', snapDate)
            .limit(1)
            .maybeSingle();
          if (synRow) {
            is_synthetic = !!synRow.is_synthetic;
            synthetic_snapshot_date = snapDate;
          }
          // 12-store totals: pull (store, amount) for the displayed snap
          // (and respecting p_branch when set). Paginated by .range() per
          // MEGAJOB Decisions Log 2026-05-12 (.limit alone caps at 1000).
          const allRows = [];
          let from = 0; const step = 1000;
          while (true) {
            let q = sb().from('inventory_snapshots')
              .select('store,amount')
              .eq('snapshot_date', snapDate)
              .order('store', { ascending: true })
              .range(from, from + step - 1);
            if (p_branch) q = q.eq('store', p_branch);
            const { data: chunk, error: cErr } = await q;
            if (cErr) throw cErr;
            if (!chunk || !chunk.length) break;
            allRows.push(...chunk);
            if (chunk.length < step) break;
            from += step;
          }
          twelve_store_by_branch = {};
          let total = 0;
          for (const r of allRows) {
            const s = r.store || '';
            const a = +r.amount || 0;
            twelve_store_by_branch[s] = (twelve_store_by_branch[s] || 0) + a;
            total += a;
          }
          twelve_store_total = +total.toFixed(2);
          for (const k of Object.keys(twelve_store_by_branch)) {
            twelve_store_by_branch[k] = +twelve_store_by_branch[k].toFixed(2);
          }
        }
      } catch (e) {
        console.error('[/api/inventory] is_synthetic/totals lookup failed:', e.message);
      }
      // Stage C-orphan-alert (2026-05-16): when items.needs_jym_review = TRUE
      // exists for SKUs that show up in the displayed snapshot, surface a
      // top-of-page alert via orphan_alert. Two-step query (PostgREST
      // embedding doesn't let us filter on the joined table cleanly):
      //   1. SELECT item_code FROM items WHERE needs_jym_review = TRUE
      //   2. SELECT inventory_snapshots rows at snapshot_date with
      //      item_code IN (orphans), optionally filtered by p_branch
      let orphan_alert = { count: 0, rows: 0, value_rm: 0, items: [] };
      try {
        const snapDate2 = (data && data.snapshot_date) || (data && data.health && data.health.snap_date) || null;
        if (snapDate2) {
          const { data: orphans } = await sb()
            .from('items').select('item_code').eq('needs_jym_review', true);
          const orphanList = (orphans || []).map(r => r.item_code).filter(Boolean);
          if (orphanList.length > 0) {
            // Chunk in case orphan list is huge (>200 hits PostgREST IN limit)
            const allInvRows = [];
            for (let i = 0; i < orphanList.length; i += 200) {
              const chunk = orphanList.slice(i, i + 200);
              let q = sb().from('inventory_snapshots')
                .select('item_code,store,amount,qty,cost')
                .eq('snapshot_date', snapDate2)
                .in('item_code', chunk);
              if (p_branch) q = q.eq('store', p_branch);
              const { data: chunkRows } = await q;
              if (chunkRows) allInvRows.push(...chunkRows);
            }
            const distinctCodes = new Set(allInvRows.map(r => r.item_code));
            const totalVal = allInvRows.reduce((s, r) => s + (+r.amount || 0), 0);
            // Sort top items by amount DESC for the modal — Jym scans biggest first.
            const sorted = allInvRows.slice().sort((a, b) => (+b.amount || 0) - (+a.amount || 0));
            orphan_alert = {
              count: distinctCodes.size,
              rows: allInvRows.length,
              value_rm: +totalVal.toFixed(2),
              items: sorted.slice(0, 100).map(r => ({
                code:   r.item_code,
                store:  r.store,
                amount: +(+r.amount || 0).toFixed(2),
                qty:    +r.qty || 0,
                cost:   r.cost == null ? null : +r.cost,
              })),
            };
          }
        }
      } catch (e) {
        console.error('[/api/inventory] orphan_alert lookup failed:', e.message);
      }
      // Override health.total_stock so the K1 card reflects ALL 12 stores
      // (not just the legacy 5-active filtered RPC result). Class breakdown
      // / order_gap / OEM-vs-Agency continue to come from the RPC (still
      // 5-active because the classifier needs sales signal that only those
      // stores have — acceptable; the surface label says so).
      const patchedData = { ...data };
      if (twelve_store_total != null) {
        patchedData.health = { ...(patchedData.health || {}), total_stock: twelve_store_total };
      }
      if (twelve_store_by_branch) {
        patchedData.by_branch = twelve_store_by_branch;
      }
      res.status(200).json({
        ok: true,
        section: section || 'kpis',
        fetched_at: new Date().toISOString(),
        source: 'supabase:wiltek-portal',
        session_role: user.role,
        session_store: user.store,
        effective_branch: p_branch,
        is_synthetic,
        synthetic_snapshot_date,
        orphan_alert,
        ...patchedData,
      });
    } catch (e) {
      console.error('[/api/inventory mode=dashboard] error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
    return;
  }

  // Phase 7 (2026-05-21) — Inventory Owner BI. One RPC returns 8-section
  // payload (hero / 5class / matrix / warehouses / abc / sku_lists / oem /
  // action_plan). Scope NOT IN ('W10','W12','WEX'). Owner can ?branch=; manager
  // pinned to own store. Old mode=dashboard untouched (Today 页可能引用).
  if (mode === 'phase7') {
    if (!user) return res.status(401).json({ ok: false, error: 'no session' });
    const queryBranch = String(req.query?.branch || '').trim().toUpperCase();
    let p_branch;
    if (user.role === 'owner') {
      p_branch = queryBranch || null;
    } else {
      if (queryBranch && queryBranch !== user.store) {
        return res.status(403).json({ ok: false, error: 'branch not allowed for this user' });
      }
      p_branch = user.store;
    }
    const p_ym = String(req.query?.month || '').trim() || null;
    try {
      const { data, error } = await sb().rpc('inventory_phase7_payload', { p_ym, p_branch });
      if (error) {
        console.error('[/api/inventory mode=phase7] RPC error:', error);
        return res.status(500).json({ ok: false, error: error.message });
      }
      return res.status(200).json({
        ok: true,
        fetched_at: new Date().toISOString(),
        source: 'supabase:wiltek-portal',
        session_role: user.role,
        session_store: user.store,
        effective_branch: p_branch,
        ...data,
      });
    } catch (e) {
      console.error('[/api/inventory mode=phase7] catch:', e);
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  // Phase 7b (2026-05-21) — Inventory 经营判断卡 (5 问 5 答 + 综合判断)。
  if (mode === 'judgement') {
    if (!user) return res.status(401).json({ ok: false, error: 'no session' });
    const p_ym = String(req.query?.month || '').trim() || null;
    try {
      const { data, error } = await sb().rpc('inventory_judgement_card', { p_ym });
      if (error) {
        console.error('[/api/inventory mode=judgement] RPC error:', error);
        return res.status(500).json({ ok: false, error: error.message });
      }
      return res.status(200).json({ ok: true, session_role: user.role, ...data });
    } catch (e) {
      console.error('[/api/inventory mode=judgement] catch:', e);
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  // Default mode — full inventory payload (row-level + classifier).
  // Manager → scope rows[] to own store. Aggregates stay company-wide
  // because the V1.6 4-state classifier needs cross-store sales signal.
  // The RPC enforces this: p_branch only filters rows[], totals/by_branch
  // always include all 5 active stores.
  const p_branch = (user && user.role === 'manager') ? user.store : null;

  try {
    const { data, error } = await sb().rpc('inventory_payload', { p_branch });
    if (error) {
      console.error('[/api/inventory] RPC error:', error);
      res.status(500).json({ ok: false, error: error.message, where: 'inventory_payload rpc' });
      return;
    }
    if (!data?.ok) {
      res.status(500).json({ ok: false, error: data?.error || 'rpc returned empty' });
      return;
    }
    res.status(200).json({
      ...data,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user?.role || null,
      session_store: user?.store || null,
    });
  } catch (e) {
    console.error('[/api/inventory] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'inventory handler' });
  }
}
