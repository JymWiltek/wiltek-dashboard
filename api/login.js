// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 1 — Login endpoint backed by Supabase users table
//
// POST { username, password }
//   → 200 { ok: true, user: { username, role, store, display_name } }
//   → 401 { ok: false, error: 'invalid' }      // bad username OR password
//   → 423 { ok: false, error: 'inactive' }     // is_active = FALSE
//   → 500 on server error (env / DB unreachable)
//
// Security:
//   - Uses SERVICE_ROLE_KEY because the user isn't authenticated yet (we
//     need to read users.password_hash before we know who they are).
//     The service role bypasses RLS — the route never returns the hash
//     to the client.
//   - Constant-ish timing: returns the same 401 for "user not found" and
//     "wrong password" (no enumeration leak).
//   - Updates users.last_login on success; failure does not record.
//
// The frontend keeps its existing SHA-256 fallback path so a Vercel
// outage / cold-start error doesn't lock everyone out. Phase 2 will
// remove the fallback once this endpoint has settled.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
function getClient() {
  if (supabase) return supabase;
  if (!URL || !KEY) {
    throw new Error('Supabase env vars missing (WILTEK_SUPABASE_URL / WILTEK_SUPABASE_SERVICE_ROLE_KEY)');
  }
  supabase = createClient(URL, KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabase;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ ok: false, error: 'POST only' }); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { res.status(400).json({ ok: false, error: 'invalid JSON' }); return; }
  }
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'username and password required' });
    return;
  }

  let sb;
  try { sb = getClient(); }
  catch (e) {
    console.error('[login] env missing:', e.message);
    res.status(500).json({ ok: false, error: 'server misconfigured' });
    return;
  }

  // Look up user (service-role bypasses RLS so this works pre-auth).
  let row;
  try {
    const { data, error } = await sb.from('users')
      .select('id, username, password_hash, role, store, display_name, is_active')
      .eq('username', username)
      .maybeSingle();
    if (error) {
      console.error('[login] db error:', error.message);
      res.status(500).json({ ok: false, error: 'db error' });
      return;
    }
    row = data;
  } catch (e) {
    console.error('[login] db throw:', e.message);
    res.status(500).json({ ok: false, error: 'db unreachable' });
    return;
  }

  if (!row) {
    // Burn ~50 ms of bcrypt time so wrong-username and wrong-password
    // share a similar timing profile (mild defence vs enumeration).
    await bcrypt.compare(password, '$2a$12$invalidsaltinvalidsaltinvalidsaltinvalidsalt000000000');
    res.status(401).json({ ok: false, error: 'invalid' });
    return;
  }
  if (!row.is_active) {
    res.status(423).json({ ok: false, error: 'inactive' });
    return;
  }

  let match = false;
  try { match = await bcrypt.compare(password, row.password_hash || ''); }
  catch (e) {
    console.error('[login] bcrypt throw:', e.message);
    res.status(500).json({ ok: false, error: 'auth error' });
    return;
  }
  if (!match) {
    res.status(401).json({ ok: false, error: 'invalid' });
    return;
  }

  // Best-effort last_login bump; failure here doesn't block login.
  try {
    await sb.from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', row.id);
  } catch (_) { /* swallow */ }

  res.status(200).json({
    ok: true,
    user: {
      username:     row.username,
      role:         row.role,
      store:        row.store,
      display_name: row.display_name,
    },
  });
}
