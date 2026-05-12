// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Sprint 3 Track 2 — /api/inventory_dashboard
//
// Top 4 KPIs for Inventory page (Stage 3, IA-doc spec):
//   1. health       — 5-class breakdown + MoM compare
//   2. order_gap    — PO vs sales + next-month projection + ABCD
//   3. stockout     — OEM (China 51d) / Agency (Malaysia 8d) buckets
//   4. oem_vs_agency— stock value / dead rate / turnover / lead
//
// Backed by inventory_dashboard_payload(p_branch) Postgres RPC.
// Manager → p_branch = user.store; owner → null (all stores).
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

  const p_branch = (user.role === 'manager') ? user.store : null;

  try {
    const { data, error } = await sb().rpc('inventory_dashboard_payload', { p_branch });
    if (error) {
      console.error('[/api/inventory_dashboard] RPC error:', error);
      res.status(500).json({ ok: false, error: error.message });
      return;
    }
    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user.role,
      session_store: user.store,
      ...data,
    });
  } catch (e) {
    console.error('[/api/inventory_dashboard] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
