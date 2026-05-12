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
