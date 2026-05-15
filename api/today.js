// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Sprint 2 Track 2 — /api/today
//
// One round-trip for the 4-layer Today page (owner home).
// Backed by today_payload(p_month, p_branch) Postgres RPC which composes:
//   Layer 1: status (light + cash_total + cash_runway + mtd_net_profit)
//   Layer 2: action_plan (3-5 cards, severity-sorted)
//   Layer 3: stores (5 W0X cards with MTD sales + walk-in + closing rate)
//   Layer 4: domains (sales/inventory/customers/products/finance/hr lights)
//
// Manager scoping (Jym spec):
//   - p_branch = user.store for managers (Finance/HR domains keep light
//     but Action Plan + store cards limited to own branch)
//   - Owner sees everything (p_branch = NULL)
//   - HR + Finance always 'unknown' light when data missing (Option A)
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
  if (!user) return res.status(401).json({ ok: false, error: 'no session' });

  // Bug 3 fix (2026-05-15): owner can ?branch=, manager pinned. Same as /api/kpi.
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
  const p_month  = String(req.query?.month || '').trim() || null;

  try {
    const { data, error } = await sb().rpc('today_payload', { p_month, p_branch });
    if (error) {
      console.error('[/api/today] RPC error:', error);
      res.status(500).json({ ok: false, error: error.message, where: 'today_payload rpc' });
      return;
    }
    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user.role,
      session_store: user.store,
      effective_branch: p_branch,
      ...data,
    });
  } catch (e) {
    console.error('[/api/today] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'today handler' });
  }
}
