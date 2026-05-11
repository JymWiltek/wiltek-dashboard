// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 2 Sprint 1 — /api/backups
//
// Owner-only.
//   GET  /api/backups
//     → returns full backups_manifest (newest first) +
//       latest 50 sync_log entries for context
//
//   POST /api/backups/recover  { backup_id: <uuid>, tables: ['sales', ...] }
//     → For each table in the manifest matching `tables` (or all if
//       omitted), TRUNCATE the public table + INSERT FROM backups.<x>.
//     → Before writes, takes a NEW pre_recover backup so the recovery
//       itself is reversible.
//     → Writes a sync_log row (mode='recover').
//     → Acquires the same advisory lock as /api/sync.
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
    .select('username, role, is_active')
    .eq('username', username).maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

function nowSuffix() {
  const d = new Date();
  return d.getUTCFullYear() + '_'
       + String(d.getUTCMonth()+1).padStart(2,'0') + '_'
       + String(d.getUTCDate()).padStart(2,'0') + '_'
       + String(d.getUTCHours()).padStart(2,'0')
       + String(d.getUTCMinutes()).padStart(2,'0');
}

async function handleList(res) {
  const [{ data: manifests }, { data: syncs }] = await Promise.all([
    sb().from('backups_manifest').select('*').order('created_at', { ascending: false }).limit(200),
    sb().from('sync_log').select('*').order('started_at', { ascending: false }).limit(50),
  ]);
  return res.status(200).json({
    ok: true, manifests: manifests || [], recent_syncs: syncs || [],
    timestamp: new Date().toISOString(),
  });
}

async function handleRecover(req, res, user) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }
  const backupId   = body?.backup_id;
  const onlyTables = Array.isArray(body?.tables) ? body.tables : null;
  if (!backupId) return res.status(400).json({ ok: false, error: 'backup_id required' });

  // 1. Look up manifest.
  const { data: manifest, error: mErr } = await sb().from('backups_manifest')
    .select('*').eq('id', backupId).maybeSingle();
  if (mErr || !manifest) return res.status(404).json({ ok: false, error: 'backup_id not found' });

  // 2. Lock — same advisory key as sync (recovery and sync are mutually exclusive).
  const { data: lockResult } = await sb().rpc('try_sync_lock');
  if (lockResult !== true) {
    return res.status(423).json({ ok: false, error: 'another sync/recover is in progress' });
  }

  // 3. Open sync_log row.
  const { data: logIns } = await sb().from('sync_log').insert({
    triggered_by: user.username, mode: 'recover',
    target_tables: (manifest.tables_backed_up || []).map(t => t.table.split('.').pop()),
    status: 'running',
    sheet_ids: [`recover_from:${backupId}`],
  }).select('id').single();
  const sync_log_id = logIns.id;

  // 4. Take a FRESH pre_recover backup of the current state so the
  //    recovery itself is reversible.
  const suffix    = nowSuffix();
  const preBackups = [];
  for (const t of (manifest.tables_backed_up || [])) {
    const [schema, table] = t.table.split('.');
    const targetTable = table || t.table;
    if (onlyTables && !onlyTables.includes(targetTable)) continue;
    try {
      const { data: bk } = await sb().rpc('backup_table', {
        p_src_schema: schema || 'public', p_src_table: targetTable, p_suffix: 'prerecover_' + suffix,
      });
      preBackups.push(bk || { table: targetTable, rows: 0, backup: null });
    } catch (e) {
      await sb().from('sync_log').update({
        finished_at: new Date().toISOString(),
        status: 'failed', error_msg: 'pre_recover backup failed for ' + targetTable + ': ' + e.message,
      }).eq('id', sync_log_id);
      await sb().rpc('release_sync_lock');
      return res.status(500).json({ ok: false, error: 'pre_recover backup failed' });
    }
  }
  const { data: preManifest } = await sb().from('backups_manifest').insert({
    triggered_by: user.username, kind: 'pre_recover',
    tables_backed_up: preBackups, sync_log_id,
    notes: `Auto pre-recover snapshot before restoring from ${backupId}`,
  }).select('id').single();

  // 5. Actually restore each table from manifest backup.
  const results = [];
  let anyFailed = false;
  for (const t of (manifest.tables_backed_up || [])) {
    const [schema, table] = t.table.split('.');
    const tableName = table || t.table;
    if (onlyTables && !onlyTables.includes(tableName)) continue;
    const backupName = (t.backup || '').split('.').pop().replace(/^"|"$/g, '');
    try {
      const { data: r } = await sb().rpc('restore_table', {
        p_backup_name: backupName, p_target_schema: schema || 'public', p_target_table: tableName,
      });
      results.push(r);
    } catch (e) {
      anyFailed = true;
      results.push({ table: t.table, error: e.message });
    }
  }
  await sb().from('sync_log').update({
    finished_at: new Date().toISOString(),
    status: anyFailed ? 'partial' : 'success',
    backup_manifest_id: preManifest.id,
    rows_appended: Object.fromEntries(results.filter(r => r.table).map(r => [r.table.split('.').pop(), r.rows])),
  }).eq('id', sync_log_id);
  await sb().rpc('release_sync_lock');

  return res.status(200).json({
    ok: true,
    sync_log_id,
    pre_recover_manifest_id: preManifest.id,
    restored_from_manifest_id: backupId,
    results,
    timestamp: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-user');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);
  if (!user) return res.status(401).json({ ok: false, error: 'no session' });
  if (user.role !== 'owner') return res.status(403).json({ ok: false, error: 'owner only' });

  try {
    if (req.method === 'GET')                                      return handleList(res);
    if (req.method === 'POST' && /recover$/.test(req.url))          return handleRecover(req, res, user);
    if (req.method === 'POST')                                      return handleRecover(req, res, user);
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  } catch (e) {
    console.error('[/api/backups] error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
