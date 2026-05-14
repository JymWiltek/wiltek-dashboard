// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Sprint 5 P0 — /api/kpi merged KPI endpoint
//
// ONE endpoint, FIVE views (sales / inventory / customers / floatation /
// products). Reads from materialized views (mv_*_kpi_monthly) via 5 RPCs
// (sales_kpi_one_month / inventory_kpi_one_month / customers_kpi_one_month
// / floatation_kpi_one_month / products_kpi_one_month).
//
// Returns: jsonb shape per RPC — current-month numbers + 3 comparison rows
// (last_month / last_year / 6-month avg) + by_branch breakdown.
//
// Auth (same model as /api/sales — Phase 1 trusted header):
//   - Caller passes `x-wp-user: <username>` header.
//   - Owner: can request any ?branch=, or no branch = all stores.
//   - Manager: branch forced to own store, regardless of ?branch=.
//
// Query params:
//   view   = sales | inventory | customers | floatation | products  (required)
//   month  = YYYY-MM                                                (required)
//   branch = W01 | W02 | ... | WCO  (optional; owner only ignored for mgr)
//
// Performance: mview-backed, target < 500ms p50.
// Cache: no-store (KPI always fresh, per Track C contract).
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const ALLOWED_VIEWS = ['sales', 'inventory', 'customers', 'floatation', 'products'];

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

  const view = String(req.query?.view || '').trim().toLowerCase();
  const ym   = String(req.query?.month || '').trim();
  const queryBranch = String(req.query?.branch || '').trim().toUpperCase();

  if (!ALLOWED_VIEWS.includes(view)) {
    res.status(400).json({ ok: false, error: 'bad view; allowed: ' + ALLOWED_VIEWS.join(',') });
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    res.status(400).json({ ok: false, error: 'bad month; expected YYYY-MM' });
    return;
  }

  // RBAC — same model as /api/sales
  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);

  let effectiveBranch = null;
  if (user) {
    if (user.role === 'owner') {
      // owner: branch query honored (or null = all)
      effectiveBranch = queryBranch || null;
    } else {
      // manager: pinned to own store
      if (queryBranch && queryBranch !== user.store) {
        res.status(403).json({ ok: false, error: 'branch not allowed for this user' });
        return;
      }
      effectiveBranch = user.store;
    }
  } else {
    // No session header (legacy compat with /api/sales pattern) → owner-equivalent.
    // Phase 2 will turn this into 401.
    effectiveBranch = queryBranch || null;
  }

  const rpcName = view + '_kpi_one_month';

  try {
    const { data, error } = await sb().rpc(rpcName, {
      p_ym: ym,
      p_branch: effectiveBranch,
    });
    if (error) {
      console.error('[/api/kpi] rpc ' + rpcName + ' error:', error.message);
      res.status(500).json({ ok: false, error: error.message, where: rpcName });
      return;
    }

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      view,
      session_role: user?.role || null,
      session_store: user?.store || null,
      effective_branch: effectiveBranch,
      data: data || {},
    });
  } catch (e) {
    console.error('[/api/kpi] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'kpi handler' });
  }
}
