// Sprint 4 Track 1 — /api/inventory_alerts
// 4 alert cards: PO calendar, transfer engine, liquidation, PO anomalies

import { createClient } from '@supabase/supabase-js';

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
function sb() {
  if (supabase) return supabase;
  supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

async function loadSessionUser(username) {
  if (!username) return null;
  const { data, error } = await sb().from('users')
    .select('username, role, store, is_active').eq('username', username).maybeSingle();
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

  const user = await loadSessionUser(String(req.headers['x-wp-user'] || '').trim().toLowerCase());
  if (!user) return res.status(401).json({ ok: false, error: 'no session' });
  const p_branch = user.role === 'manager' ? user.store : null;
  try {
    const { data, error } = await sb().rpc('inventory_alerts_payload', { p_branch });
    if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
    res.status(200).json({ ok: true, fetched_at: new Date().toISOString(),
      session_role: user.role, session_store: user.store, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
