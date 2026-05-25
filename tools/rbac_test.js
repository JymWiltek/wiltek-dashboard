#!/usr/bin/env node
/* ============================================================================
 * tools/rbac_test.js — V2 Launch 件2: 9-user RBAC matrix test
 * ----------------------------------------------------------------------------
 * 从 Wiltek_V2.html 抽出 rbacRole() + RBAC 对象, 在 VM 沙箱里跑, 断言
 * 9 个用户 × 9 页 的可见性矩阵 (Jym 2026-05-25 拍板). 另用 source 断言
 * 强制 store scope (manager 锁本店 / 非 manager 可选 branch).
 *
 * state.role 归一化: w0X_mgr → 'manager'; owner → 'owner';
 *   hr/marketing/warehouse → 自身 (rbacRole 归类为 'staff').
 *
 * 跑法: node tools/rbac_test.js   (退出码 = 失败数)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'Wiltek_V2.html');
const src = fs.readFileSync(FILE, 'utf8');

function extract(re, name) {
  const m = src.match(re);
  if (!m) { console.error('FATAL: cannot find ' + name + ' in Wiltek_V2.html'); process.exit(2); }
  return m[0];
}
const rbacRoleSrc = extract(/function rbacRole\(role\)\s*\{[\s\S]*?\n\}/, 'rbacRole()');
const rbacObjSrc  = extract(/const RBAC = \{[\s\S]*?\n\};/, 'RBAC object');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(rbacRoleSrc + '\n' + rbacObjSrc + '\nthis.RBAC = RBAC;', sandbox);
const RBAC = sandbox.RBAC;

// 9 用户 (state.role 归一化后). manager 代表 w01/w02/w03/w05/w07 (同权限, 不同 scope).
const STAFF_CAN = ['overview', 'sales', 'inventory', 'customers', 'products', 'today', 'inbox'];
const OWNER_ONLY = ['finance', 'targets'];
const ALL_PAGES = [...STAFF_CAN, ...OWNER_ONLY];

const cases = [
  { user: 'owner',     role: 'owner',     can: ALL_PAGES,  scope: 'all' },
  { user: 'hr',        role: 'hr',        can: STAFF_CAN,  scope: 'all' },
  { user: 'marketing', role: 'marketing', can: STAFF_CAN,  scope: 'all' },
  { user: 'warehouse', role: 'warehouse', can: STAFF_CAN,  scope: 'all' },
  { user: 'w01_mgr',   role: 'manager',   can: STAFF_CAN,  scope: 'W01' },
  { user: 'w02_mgr',   role: 'manager',   can: STAFF_CAN,  scope: 'W02' },
  { user: 'w03_mgr',   role: 'manager',   can: STAFF_CAN,  scope: 'W03' },
  { user: 'w05_mgr',   role: 'manager',   can: STAFF_CAN,  scope: 'W05' },
  { user: 'w07_mgr',   role: 'manager',   can: STAFF_CAN,  scope: 'W07' },
];

let fails = 0, total = 0;
for (const c of cases) {
  for (const page of ALL_PAGES) {
    total++;
    const expected = c.can.includes(page);
    const got = RBAC.canSeePage(c.role, page);
    if (got !== expected) {
      fails++;
      console.error(`✗ ${c.user} (${c.role}) × ${page}: expected ${expected}, got ${got}`);
    }
  }
}

// Source-level scope enforcement assertions (defense-in-depth, can't loop the UI here)
function assertSource(re, label) {
  total++;
  if (!re.test(src)) { fails++; console.error('✗ source check failed: ' + label); }
}
assertSource(/function getEffectiveBranch\(\)\s*\{[\s\S]*?state\.role === 'manager'[\s\S]*?user\.store/, 'getEffectiveBranch pins manager to own store');
assertSource(/function onBranchChange\(b\)\s*\{\s*\n\s*if \(state\.role === 'manager'\) return;/, 'onBranchChange blocks manager branch switch');
assertSource(/branchPicker'\)\.style\.display = \(state\.role === 'manager'\) \? 'none' : ''/, 'branch picker hidden for manager');
assertSource(/if \(!RBAC\.canSeePage\(state\.role, state\.view\)\)/, 'loadView RBAC guard present');
assertSource(/applyRbacToNav\(state\.role\)/, 'enterApp applies RBAC to nav');

console.log(`\nRBAC test: ${total - fails}/${total} assertions passed.`);
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('✓ PASS — 9 users × 9 pages matrix + store-scope enforcement.');
