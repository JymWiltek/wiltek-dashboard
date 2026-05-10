// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 1 — /api/floatation backed by Supabase
//
// Replaces the 5-Sheet CSV fetch path with a single SELECT against the
// Supabase floatation table. Rebuilds the legacy response shape exactly:
//
//   { ok, fetched_at, year, months, month_idx, races, totals,
//     by_branch, branches_full, diagnostics }
//
// branches_full[branch].races.{all,chinese,malay,indian,others} keeps
// the .walkin / .purchase / .amount / .basket / .cr arrays the V1.7
// frontend uses (manager Today KPI table + Customer race section).
//
// Auth (Phase 1 trusted x-wp-user header):
//   Owner   → all 5 active stores
//   Manager → only their own store
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

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

function emptyRace12() {
  return {
    walkin:   Array(12).fill(0),
    purchase: Array(12).fill(0),
    amount:   Array(12).fill(0),
    basket:   Array(12).fill(null),
    cr:       Array(12).fill(null),
  };
}

function buildBranchesFull(rows) {
  const result = {};
  for (const br of ACTIVE_BRANCHES) {
    result[br] = {
      races: {
        all:     emptyRace12(),
        chinese: emptyRace12(),
        malay:   emptyRace12(),
        indian:  emptyRace12(),
        others:  emptyRace12(),
      },
    };
  }
  for (const r of rows) {
    if (!ACTIVE_BRANCHES.includes(r.store)) continue;
    const m = +String(r.date).split('-')[1] - 1;
    if (m < 0 || m > 11) continue;
    const races = result[r.store].races;
    races.all.walkin[m]   = +r.walk_in_total || 0;
    races.all.purchase[m] = +r.closed_count || 0;
    races.all.amount[m]   = +r.amount_total || 0;
    races.all.basket[m]   = r.basket_total != null ? +r.basket_total : null;
    races.all.cr[m]       = r.closing_rate != null ? (+r.closing_rate / 100) : null;

    races.chinese.walkin[m] = +r.walk_in_chinese || 0;
    races.malay.walkin[m]   = +r.walk_in_malay   || 0;
    races.indian.walkin[m]  = +r.walk_in_indian  || 0;
    races.others.walkin[m]  = +r.walk_in_other   || 0;

    const br = r.by_race || {};
    for (const k of ['chinese', 'malay', 'indian', 'others']) {
      const cell = br[k] || {};
      races[k].purchase[m] = +(cell.purchase || 0);
      races[k].amount[m]   = +(cell.amount   || 0);
      races[k].basket[m]   = (cell.purchase > 0)
        ? Math.round((cell.amount / cell.purchase) * 100) / 100
        : null;
      const wc = races[k].walkin[m];
      races[k].cr[m] = wc > 0
        ? Math.round((cell.purchase / wc) * 10000) / 10000
        : null;
    }
  }
  return result;
}

function pickWindow(branches_full) {
  let latestM = -1;
  for (const br of ACTIVE_BRANCHES) {
    const arr = branches_full[br]?.races?.all?.walkin || [];
    for (let m = 11; m >= 0; m--) {
      if (arr[m] > 0 && m > latestM) { latestM = m; break; }
    }
  }
  if (latestM < 0) latestM = 0;
  const idx = [latestM - 2, latestM - 1, latestM]
    .filter(v => v >= 0)
    .filter((v, i, a) => a.indexOf(v) === i);
  const month_idx = idx.map(i => i + 1);   // 1-based
  const year = new Date().getFullYear();
  const months = month_idx.map(m => `${year}-${String(m).padStart(2, '0')}`);
  return { month_idx, months, year };
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

  try {
    const yr = new Date().getFullYear();
    let q = sb().from('floatation').select('*')
      .gte('date', `${yr}-01-01`)
      .lt('date', `${yr + 1}-01-01`);
    if (user && user.role === 'manager') q = q.eq('store', user.store);
    const { data: rows, error } = await q;
    if (error) {
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    const branches_full = buildBranchesFull(rows || []);
    const { month_idx, months, year } = pickWindow(branches_full);
    const winIdx0 = month_idx.map(m => m - 1);

    const raceKeys = ['chinese', 'malay', 'indian', 'others'];
    const races = raceKeys.map(rk => {
      const walkin   = winIdx0.map(i => ACTIVE_BRANCHES.reduce((s, br) => s + (branches_full[br]?.races?.[rk]?.walkin?.[i]   || 0), 0));
      const purchase = winIdx0.map(i => ACTIVE_BRANCHES.reduce((s, br) => s + (branches_full[br]?.races?.[rk]?.purchase?.[i] || 0), 0));
      const amount   = winIdx0.map(i => ACTIVE_BRANCHES.reduce((s, br) => s + (branches_full[br]?.races?.[rk]?.amount?.[i]   || 0), 0));
      const basket   = walkin.map((_, i) => (purchase[i] && amount[i]) ? Math.round((amount[i] / purchase[i]) * 100) / 100 : null);
      const cr       = walkin.map((w, i) => (w && purchase[i]) ? Math.round((purchase[i] / w) * 10000) / 10000 : null);
      return {
        key: rk,
        label_en: { chinese: 'Chinese', malay: 'Malay', indian: 'Indian', others: 'Others' }[rk],
        label_zh: { chinese: '华族',     malay: '马来族', indian: '印度族', others: '其他'   }[rk],
        walkin, purchase, amount, basket, cr,
      };
    });

    const totWalkin   = winIdx0.map((_, i) => races.reduce((s, r) => s + (r.walkin[i]   || 0), 0) || null);
    const totPurchase = winIdx0.map((_, i) => races.reduce((s, r) => s + (r.purchase[i] || 0), 0) || null);
    const totAmount   = winIdx0.map((_, i) => races.reduce((s, r) => s + (r.amount[i]   || 0), 0) || null);
    const totBasket   = totPurchase.map((p, i) => (p && totAmount[i]) ? Math.round((totAmount[i] / p) * 100) / 100 : null);
    const totCr       = totWalkin.map((w, i)  => (w && totPurchase[i]) ? Math.round((totPurchase[i] / w) * 10000) / 10000 : null);

    const by_branch = {};
    for (const br of ACTIVE_BRANCHES) {
      const all = branches_full[br]?.races?.all || emptyRace12();
      const walkin   = winIdx0.reduce((s, i) => s + (all.walkin[i]   || 0), 0);
      const purchase = winIdx0.reduce((s, i) => s + (all.purchase[i] || 0), 0);
      const amount   = winIdx0.reduce((s, i) => s + (all.amount[i]   || 0), 0);
      by_branch[br] = {
        walkin, purchase,
        amount: Math.round(amount * 100) / 100,
        basket: purchase ? Math.round((amount / purchase) * 100) / 100 : null,
        cr:     walkin   ? Math.round((purchase / walkin) * 10000) / 10000 : null,
      };
    }

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user?.role || null,
      session_store: user?.store || null,
      year,
      months,
      month_idx,
      races,
      totals: { walkin: totWalkin, purchase: totPurchase, amount: totAmount, basket: totBasket, cr: totCr },
      by_branch,
      branches_full,
      note_en: `Live walk-in (${months[0]} to ${months[months.length-1]}) — Supabase floatation table.`,
      note_zh: `实时进店数据(${months[0]} 至 ${months[months.length-1]})— 来自 Supabase floatation 表。`,
    });
  } catch (e) {
    console.error('[/api/floatation] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'floatation handler' });
  }
}
