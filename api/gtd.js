// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 1 — /api/gtd backed by Supabase
//
// Replaces the GitHub Gist storage with the Supabase gtd_tasks +
// gtd_kpis tables. The on-the-wire shape (flat key→value map) is
// preserved so the existing renderGtd / gtdLoadStore frontend works
// without changes.
//
// Key formats consumed/emitted (compatible with the legacy gist
// schema set by Wiltek_MASTER.html → gtdGetCellValue):
//   <branch>::task::<task_id>::<monthIdx>             → status string
//   <branch>::kpi::<kpi_id>::<monthIdx>               → actual numeric
//   <branch>::target_month::<kpi_id>::<monthIdx>      → target numeric
//   <branch>::target::<kpi_id>                        → branch-default
//                                                       target (Phase 1
//                                                       fans out to all
//                                                       12 months for
//                                                       this branch)
//
// Auth (x-wp-user header):
//   GET  · Manager → returns ONLY their store's keys + global default
//                    targets if any. Owner → all stores.
//   POST · Manager → can write tasks + actual KPI values for their own
//                    store. CANNOT write target/target_month (owner-only).
//                    Cross-store writes return 403.
//          Owner   → can write any store, including target/target_month.
//
// monthIdx ↔ year_month convention: idx 0 = Jan, 11 = Dec. Year is
// derived from the writer's intent — current year by default. Existing
// rows from Phase 0 migration use 2026.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

// 5 active retail stores. Keep this list in sync with api/sales.js,
// api/floatation.js, etc. — single source of truth.
const ACTIVE_BRANCHES = ['W01', 'W02', 'W03', 'W05', 'W07'];

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

// ── Key parser ────────────────────────────────────────────────────────
function parseKey(k) {
  // Returns { branch, kind, id, monthIdx } or null if malformed.
  const parts = String(k).split('::');
  if (parts.length < 3) return null;
  const [branch, kind, ...rest] = parts;
  if (kind === 'task') {
    return { branch, kind, id: rest[0], monthIdx: parseInt(rest[1], 10) };
  }
  if (kind === 'kpi') {
    return { branch, kind, id: rest[0], monthIdx: parseInt(rest[1], 10) };
  }
  if (kind === 'target_month') {
    return { branch, kind, id: rest[0], monthIdx: parseInt(rest[1], 10) };
  }
  if (kind === 'target') {
    return { branch, kind, id: rest[0], monthIdx: null };
  }
  return null;
}

function ymFromMonthIdx(idx, year) {
  if (idx < 0 || idx > 11) return null;
  return `${year}-${String(idx + 1).padStart(2, '0')}`;
}
function monthIdxFromYm(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) return null;
  return parseInt(ym.split('-')[1], 10) - 1;
}

// ── GET handler: fetch all rows, flatten to legacy key map ───────────
async function handleGet(res, user) {
  // Manager: only own-store data. Owner: all.
  let qTasks = sb().from('gtd_tasks').select('store, year_month, task_name, status');
  let qKpis  = sb().from('gtd_kpis').select('store, year_month, kpi_name, target, actual');
  if (user && user.role === 'manager') {
    qTasks = qTasks.eq('store', user.store);
    qKpis  = qKpis.eq('store',  user.store);
  }
  const [tRes, kRes] = await Promise.all([qTasks, qKpis]);
  if (tRes.error) return res.status(500).json({ ok: false, error: 'tasks: ' + tRes.error.message });
  if (kRes.error) return res.status(500).json({ ok: false, error: 'kpis: '  + kRes.error.message });

  const store = {};
  for (const r of (tRes.data || [])) {
    const idx = monthIdxFromYm(r.year_month);
    if (idx == null) continue;
    if (r.status) store[`${r.store}::task::${r.task_name}::${idx}`] = r.status;
  }
  for (const r of (kRes.data || [])) {
    const idx = monthIdxFromYm(r.year_month);
    if (idx == null) continue;
    if (r.actual != null)  store[`${r.store}::kpi::${r.kpi_name}::${idx}`]          = r.actual;
    if (r.target != null)  store[`${r.store}::target_month::${r.kpi_name}::${idx}`] = r.target;
  }

  res.status(200).json({
    ok: true,
    store,
    fetched_at: new Date().toISOString(),
    source: 'supabase:wiltek-portal',
    session_role: user?.role || null,
    session_store: user?.store || null,
    rows: { tasks: tRes.data?.length || 0, kpis: kRes.data?.length || 0 },
  });
}

// ── POST handler: validate + upsert ──────────────────────────────────
async function handlePost(req, res, user) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }
  const writerBranch = String(body?.branch || '').trim();
  const incoming    = body?.store && typeof body.store === 'object' ? body.store : null;
  if (!writerBranch || !incoming) {
    return res.status(400).json({ ok: false, error: 'branch and store{} required' });
  }

  // Authorization rules:
  //   - Owner:   may write any branch's keys (including target/target_month).
  //   - Manager: writerBranch MUST equal user.store; cannot write target/target_month.
  //   - No session: reject (Phase 1 always requires identity for writes).
  if (!user) return res.status(401).json({ ok: false, error: 'no session' });
  const isOwner = user.role === 'owner';
  if (!isOwner && writerBranch !== user.store) {
    return res.status(403).json({ ok: false, error: 'manager can only write own store' });
  }

  // Validate every key + bucket into task / kpi-actual / target writes.
  const taskUpserts = [];
  const kpiActualUpserts = [];
  const kpiTargetUpserts = [];
  const skipped = [];
  for (const [k, v] of Object.entries(incoming)) {
    const parsed = parseKey(k);
    if (!parsed) { skipped.push({ key: k, reason: 'malformed' }); continue; }
    if (parsed.branch !== writerBranch && !isOwner) {
      // Manager attempting cross-branch via key → 403.
      return res.status(403).json({ ok: false, error: `cross-branch key not allowed: ${k}` });
    }
    const branch = parsed.branch;
    if (parsed.kind === 'task') {
      const ym = ymFromMonthIdx(parsed.monthIdx, 2026);
      if (!ym) { skipped.push({ key: k, reason: 'bad monthIdx' }); continue; }
      // Status must be a known token.
      const status = String(v || '').trim().toLowerCase();
      const valid  = ['done', 'updated', 'undone', ''].includes(status);
      if (!valid) { skipped.push({ key: k, reason: `invalid status "${v}"` }); continue; }
      taskUpserts.push({
        store: branch, year_month: ym, task_name: parsed.id,
        status: status || null, updated_by: user.username,
      });
    } else if (parsed.kind === 'kpi') {
      const ym = ymFromMonthIdx(parsed.monthIdx, 2026);
      if (!ym) { skipped.push({ key: k, reason: 'bad monthIdx' }); continue; }
      const num = (v === '' || v == null) ? null : Number(v);
      if (num != null && !Number.isFinite(num)) { skipped.push({ key: k, reason: 'NaN actual' }); continue; }
      kpiActualUpserts.push({
        store: branch, year_month: ym, kpi_name: parsed.id,
        actual: num, updated_by: user.username,
      });
    } else if (parsed.kind === 'target_month') {
      if (!isOwner) {
        return res.status(403).json({ ok: false, error: 'only owner can write target' });
      }
      const ym = ymFromMonthIdx(parsed.monthIdx, 2026);
      if (!ym) { skipped.push({ key: k, reason: 'bad monthIdx' }); continue; }
      const num = (v === '' || v == null) ? null : Number(v);
      if (num != null && !Number.isFinite(num)) { skipped.push({ key: k, reason: 'NaN target' }); continue; }
      kpiTargetUpserts.push({
        store: branch, year_month: ym, kpi_name: parsed.id,
        target: num, updated_by: user.username,
      });
    } else if (parsed.kind === 'target') {
      // Branch-default target (no month). Phase 1 fans out to all 12 months.
      if (!isOwner) {
        return res.status(403).json({ ok: false, error: 'only owner can write target' });
      }
      const num = (v === '' || v == null) ? null : Number(v);
      if (num != null && !Number.isFinite(num)) { skipped.push({ key: k, reason: 'NaN target' }); continue; }
      for (let m = 0; m < 12; m++) {
        const ym = ymFromMonthIdx(m, 2026);
        kpiTargetUpserts.push({
          store: branch, year_month: ym, kpi_name: parsed.id,
          target: num, updated_by: user.username,
        });
      }
    }
  }

  // Apply writes — in 3 separate UPSERT calls so an error in one bucket
  // doesn't block the others.
  const errors = [];
  let written = 0;

  if (taskUpserts.length) {
    const { error, count } = await sb().from('gtd_tasks')
      .upsert(taskUpserts, { onConflict: 'store,year_month,task_name', count: 'exact' });
    if (error) errors.push('tasks: ' + error.message);
    else written += count || taskUpserts.length;
  }

  // For KPI actuals: these may target rows that don't exist yet (new
  // store-month-kpi combo). Upsert with onConflict that updates only
  // the actual column (target stays untouched).
  if (kpiActualUpserts.length) {
    const { error, count } = await sb().from('gtd_kpis')
      .upsert(kpiActualUpserts, { onConflict: 'store,year_month,kpi_name', count: 'exact', ignoreDuplicates: false });
    if (error) errors.push('kpi_actual: ' + error.message);
    else written += count || kpiActualUpserts.length;
  }

  if (kpiTargetUpserts.length) {
    // Target writes: upsert. If row exists, target overwritten; actual untouched
    // (because we didn't include it in the upsert object).
    const { error, count } = await sb().from('gtd_kpis')
      .upsert(kpiTargetUpserts, { onConflict: 'store,year_month,kpi_name', count: 'exact', ignoreDuplicates: false });
    if (error) errors.push('kpi_target: ' + error.message);
    else written += count || kpiTargetUpserts.length;
  }

  if (errors.length) {
    return res.status(207).json({ ok: false, error: errors.join(' | '), written, skipped });
  }
  res.status(200).json({
    ok: true,
    written,
    tasks: taskUpserts.length,
    kpi_actuals: kpiActualUpserts.length,
    kpi_targets: kpiTargetUpserts.length,
    skipped,
    fetched_at: new Date().toISOString(),
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

  try {
    if (req.method === 'GET')  return handleGet(res, user);
    if (req.method === 'POST') return handlePost(req, res, user);
    res.status(405).json({ ok: false, error: 'GET or POST only' });
  } catch (e) {
    console.error('[/api/gtd] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'gtd handler' });
  }
}
