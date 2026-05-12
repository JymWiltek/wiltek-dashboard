// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Sprint 2 — /api/customers thin wrapper over RPC.
//
// Sprint 1 version pulled v_member_purchases (60k rows) + customers
// (14k rows) into Node, then iterated them to compute summary,
// buckets_by_window, cross_by_window, top100, churn, sales_by_branch_month
// in pure JS — ~10-12s cold. Sprint 2 moves all aggregation into a
// single Postgres RPC `customers_payload(p_month, p_branch)`; this
// handler just forwards the JSON + composes loyalty_v17_by_branch
// (still a separate RPC since it has its own per-branch logic).
//
// Response shape preserved exactly so renderCustomersDashboard /
// renderChurn / V1.7 lapsed radar continue to work unchanged.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const ACTIVE_BRANCHES = ['W01','W02','W03','W05','W07'];

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
  const allowedBranch = (user && user.role === 'manager') ? user.store : null;

  // Resolve snapshot ym.
  let snapshotYm = String(req.query?.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(snapshotYm)) {
    const { data, error } = await sb().from('v_total_amt_by_month')
      .select('ym').order('ym', { ascending: false }).limit(1);
    if (error || !data?.length) {
      res.status(500).json({ ok: false, error: 'cannot resolve snapshot' });
      return;
    }
    snapshotYm = data[0].ym;
  }

  // months_seen for the frontend month picker.
  let months_seen = [];
  try {
    const { data } = await sb().from('v_total_amt_by_month').select('ym').order('ym');
    months_seen = (data || []).map(r => r.ym);
  } catch (_) { /* best-effort */ }

  try {
    // Single RPC call replaces ~10s of JS-side aggregation.
    const payloadPromise = sb().rpc('customers_payload', {
      p_month: snapshotYm, p_branch: allowedBranch,
    });

    // Loyalty V1.7 still uses its dedicated per-branch RPC — call in parallel.
    const branchesForLoyalty = allowedBranch ? [allowedBranch] : ACTIVE_BRANCHES;
    const loyaltyPromises = branchesForLoyalty.map(br =>
      sb().rpc('loyalty_v17_for_branch', { p_branch: br, snap_ym: snapshotYm })
        .then(r => [br, r.data, r.error])
    );

    const [payloadRes, ...loyaltyRes] = await Promise.all([payloadPromise, ...loyaltyPromises]);
    if (payloadRes.error) {
      console.error('[/api/customers] customers_payload error:', payloadRes.error);
      res.status(500).json({ ok: false, error: payloadRes.error.message });
      return;
    }
    const payload = payloadRes.data || {};
    const loyalty_v17_by_branch = {};
    for (const [br, data, err] of loyaltyRes) {
      if (err) console.error(`[loyalty_v17] ${br}: ${err.message}`);
      loyalty_v17_by_branch[br] = data ?? null;
    }

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user?.role || null,
      session_store: user?.store || null,
      months_seen,
      snapshot: snapshotYm,
      requested_month: req.query?.month || null,
      ...payload,
      loyalty_v17_by_branch,
    });
  } catch (e) {
    console.error('[/api/customers] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'customers handler' });
  }
}
