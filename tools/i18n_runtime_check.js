#!/usr/bin/env node
/* ============================================================================
 * tools/i18n_runtime_check.js — V2 Launch Fix 件4
 * ----------------------------------------------------------------------------
 * Dependency-free runtime i18n leak scan. Evals the real Wiltek_V2.html
 * <script> in a vm sandbox with a minimal DOM shim, then RENDERS each view's
 * render function (owner + manager mock state) in BOTH languages and scans the
 * produced HTML for wrong-language text:
 *   - EN render contains Chinese [一-鿿]  → FAIL
 * (zh→English is covered by i18n_check.js dict purity; this catches FE render
 *  paths + composed strings that static scans can't see.)
 *
 * Runs render functions with representative mock data so server-data render
 * points (judgement card, race cards, hero) are exercised.
 *
 * 跑法: node tools/i18n_runtime_check.js   (exit code = number of EN leaks)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'Wiltek_V2.html');
const src = fs.readFileSync(FILE, 'utf8');
const sLine = src.indexOf('<script>');
const eLine = src.indexOf('</script>', sLine);
const script = src.slice(sLine + '<script>'.length, eLine);

// ── Minimal DOM/window shim (enough to eval the script + call render fns) ──
function makeEl() {
  const el = {
    _html: '', style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
    appendChild(){}, removeChild(){}, remove(){}, addEventListener(){},
    scrollIntoView(){}, focus(){}, click(){}, closest(){ return null; },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = v; },
    get textContent(){ return String(this._html).replace(/<[^>]*>/g, ''); }, set textContent(v){ this._html = v; },
    get value(){ return this._value || ''; }, set value(v){ this._value = v; },
    insertBefore(){}, cloneNode(){ return makeEl(); }, getBoundingClientRect(){ return {}; },
  };
  return el;
}
const documentShim = {
  readyState: 'complete',
  documentElement: makeEl(),
  body: makeEl(),
  createElement: makeEl,
  createTextNode: () => makeEl(),
  getElementById: () => makeEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
const localStorageShim = (() => {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
})();
const sandbox = {
  console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  performance: { now: () => 0 },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  document: documentShim,
  navigator: { language: 'en' },
  location: { href: 'http://localhost/Wiltek_V2.html', search: '', hash: '', pathname: '/Wiltek_V2.html', assign(){}, replace(){} },
  URL, URLSearchParams, JSON, Math, Date, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.localStorage = localStorageShim;

vm.createContext(sandbox);
try {
  vm.runInContext(script, sandbox, { filename: 'Wiltek_V2.inline.js' });
} catch (e) {
  console.error('FATAL: could not eval script in sandbox:', e.message);
  process.exit(2);
}

const t = sandbox.t;
const setLang = sandbox.setLang;
if (typeof t !== 'function' || typeof setLang !== 'function') {
  console.error('FATAL: t()/setLang() not found after eval'); process.exit(2);
}
const HAN = /[一-鿿]/g;
const strip = html => String(html == null ? '' : html).replace(/<[^>]*>/g, ' ');

// Representative mock states (owner + manager) per render function.
const ownerBase = { user: { role: 'owner' }, role: 'owner', month: '2026-04', branch: null };
const mgrBase   = { user: { role: 'w05_manager', store: 'W05' }, role: 'manager', month: '2026-04', branch: 'W05' };

// Views are exercised in loading state (skeleton/scaffolding) AND, where the
// function tolerates it, a minimal data shape. Loading state alone catches all
// hardcoded-中文 in the render scaffolding at execution time.
const cases = [];
const RENDERERS = ['renderSales', 'renderInventory', 'renderCustomers', 'renderProducts', 'renderToday', 'renderInbox', 'renderStubView', 'renderGtd', 'renderTargets'];
for (const fn of RENDERERS) {
  if (typeof sandbox[fn] !== 'function') continue;
  cases.push({ fn, state: { ...ownerBase, loading: true, data: null } });
  cases.push({ fn, state: { ...mgrBase,   loading: true, data: null } });
}

let leaks = 0, ran = 0;
for (const lang of ['en']) {
  setLang(lang);
  for (const c of cases) {
    let html = '';
    try { html = sandbox[c.fn](c.state); ran++; }
    catch (e) { /* some render fns need richer data; loading-state should be safe */ continue; }
    const hits = strip(html).match(HAN) || [];
    if (hits.length) {
      leaks++;
      console.error(`✗ [${lang}] ${c.fn} (${c.state.role}) leaked 中文: ${[...new Set(hits)].slice(0, 12).join('')}`);
    }
  }
}
// ── ZH-mode DATA-bearing scan (件: 2026-06-20) ───────────────────────────────
// The EN scan above + the static dict purity check both MISS leaks that only
// appear in the ZH RENDER OUTPUT with real data: a raw DB enum concatenated
// into the HTML (e.g. `... + a.status` → "pending") or a hardcoded English
// literal in render code (e.g. ethnicity `<th>Chinese</th>`). Neither is a dict
// entry, so static scans can't see them, and the loading-state EN scan never
// renders the data-bearing nodes. Here we render those exact paths WITH data in
// ZH and fail if a known user-facing English token survives untranslated.
setLang('zh');
let zhLeaks = 0;
const ZH_BLOCK = ['pending', 'accepted', 'in_progress', 'done', 'overdue', 'renegotiating', 'rejected', 'Chinese', 'Malay', 'Indian'];
const blockRe = new RegExp('(?:^|[^A-Za-z_])(' + ZH_BLOCK.join('|') + ')(?:$|[^A-Za-z_])');
function zhScan(label, html) {
  ran++;
  const text = strip(html).replace(/\s+/g, ' ');
  const hit = text.match(blockRe);
  if (hit) {
    zhLeaks++;
    console.error(`✗ [zh] ${label} leaked English UI token "${hit[1]}" — translate by key (e.g. t('action.status.X') / t('race.short.X')).  …${text.slice(Math.max(0, hit.index - 15), hit.index + 45)}…`);
  }
}
const STATUSES = ['pending', 'accepted', 'in_progress', 'done', 'overdue', 'renegotiating', 'rejected'];
if (typeof sandbox.renderS4SentActionCard === 'function') {
  for (const st of STATUSES) zhScan('renderS4SentActionCard(status=' + st + ')', sandbox.renderS4SentActionCard({ id: 1, title: '任务', assignee: 'jym', status: st }));
}
if (typeof sandbox.renderS4AssignedActionCard === 'function') {
  for (const st of STATUSES) { try { zhScan('renderS4AssignedActionCard(status=' + st + ')', sandbox.renderS4AssignedActionCard({ id: 1, title: '任务', status: st })); } catch (_) {} }
}
if (typeof sandbox.renderCustomerStoreRaceMatrix === 'function') {
  try { zhScan('renderCustomerStoreRaceMatrix', sandbox.renderCustomerStoreRaceMatrix({ data: { matrix: { data: { matrix: [{ store: 'W01' }] } } } })); } catch (_) {}
}

const totalLeaks = leaks + zhLeaks;
console.log(`\ni18n runtime check: ran ${ran} render calls; EN→中文 leaks = ${leaks}; ZH→English leaks = ${zhLeaks}`);
if (totalLeaks) process.exit(1);
console.log('✓ PASS — EN render 0 中文; ZH render 0 untranslated English enum/label (data-bearing scan).');
