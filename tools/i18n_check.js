#!/usr/bin/env node
/* ============================================================================
 * tools/i18n_check.js — V2 Launch 件1 i18n 语言纯度静态校验
 * ----------------------------------------------------------------------------
 * 配合 i18n_audit.js (查 render 里 hardcoded 中文) 使用. 本脚本查 *字典值*:
 *
 *   [HARD-FAIL]  en 值含中文 [一-鿿]      → 切 EN 必漏中文 (rule #5 主方向). 0 容忍.
 *   [HARD-FAIL]  zh 值是「纯英文」(无任何汉字, 却有英文单词) 且不在
 *                INTENTIONAL_EN 白名单里 → 切中文漏整段英文 UI label.
 *
 * 不报: zh 值「汉字 + 少量英文术语/表名/代码」(如 'Apps Script sync 后启用',
 *       '总销售 RM') — 这是技术 BI 双语内容的正常形态, 非泄漏.
 *
 * INTENTIONAL_EN: Jym 拍板保留为英文的产品级 label (Action Plan / My Target /
 *       Top VIP 等), 两语言都英文, 见 Phase 10B2 验收单. 改动需 Jym 同意.
 *
 * 跑法: node tools/i18n_check.js        (报告)
 *       node tools/i18n_check.js --ci   (退出码 = HARD-FAIL 数)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'Wiltek_V2.html');
const src = fs.readFileSync(FILE, 'utf8');

// 产品级保留英文 label (两语言都英文, Jym 设计语汇) — 非泄漏
const INTENTIONAL_EN = new Set([
  'lang.toggle',            // 语言切换钮故意显示目标语言文字
  'inv.section.action',
  'today.section.target',
  'customer.tab.top_vip',
  'app.motto',              // §9 slogan — intentionally English in both languages (Jym)
]);

const HAN = /[一-鿿]/;

// 提取 dict 对象文本
const startIdx = src.indexOf('window.i18n');
const braceOpen = src.indexOf('{', startIdx);
let depth = 0, end = -1;
for (let i = braceOpen; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const dictText = src.slice(startIdx, end + 1);

const entryRe = /'([^']+)'\s*:\s*\{\s*zh:\s*'((?:[^'\\]|\\.)*)'\s*,\s*en:\s*'((?:[^'\\]|\\.)*)'\s*\}/g;
let m, entries = [];
while ((m = entryRe.exec(dictText))) {
  entries.push({ key: m[1], zh: m[2].replace(/\\'/g, "'"), en: m[3].replace(/\\'/g, "'") });
}

const enLeaks = [];   // en value contains Chinese
const zhLeaks = [];   // pure-English zh value, not intentional
for (const e of entries) {
  if (INTENTIONAL_EN.has(e.key)) continue;   // curated bilingual-term exceptions
  if (HAN.test(e.en)) enLeaks.push(e);
  if (!HAN.test(e.zh) && /[A-Za-z]{2,}/.test(e.zh)) zhLeaks.push(e);
}

console.log('=== i18n_check: parsed ' + entries.length + ' dict entries ===');
console.log('EN-side Chinese leaks: ' + enLeaks.length + ' | ZH-side pure-English leaks: ' + zhLeaks.length + '\n');
if (enLeaks.length) {
  console.log('✗ [en] 切 EN 会显中文 (必修):');
  for (const e of enLeaks) console.log(`    ${e.key}\n        en: ${e.en}`);
}
if (zhLeaks.length) {
  console.log('✗ [zh] 切中文会显整段英文 (必修, 或加入 INTENTIONAL_EN):');
  for (const e of zhLeaks) console.log(`    ${e.key}\n        zh: ${e.zh}`);
}
const fails = enLeaks.length + zhLeaks.length;
if (!fails) console.log('✓ PASS — en 无中文; zh 无非预期纯英文 label.');

if (process.argv.includes('--ci')) process.exit(fails ? 1 : 0);
