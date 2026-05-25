#!/usr/bin/env node
/* ============================================================================
 * tools/i18n_audit.js — V2 Launch 件1
 * ----------------------------------------------------------------------------
 * 扫描 Wiltek_V2.html <script> 区里 *用户可见* 的 hardcoded 中文字符串.
 * 输出每行: line | context | 中文片段 | 是否 language-conditional (ternary)
 *
 * 排除:
 *   - i18n dict 对象本身 (window.i18n = { ... }) — 那里中文是合法的
 *   - 注释 (// ...  /* ... *​/  * ...)
 *   - console.log/warn/error/info (dev-only, 不渲染)
 *
 * 标注:
 *   - [TERNARY] = 该行含 i18n.lang 判断, 切语言时已正确 (grandfathered),
 *     但 rule #4 倾向改成 t(); 仍报出来供决策
 *   - [HARD]    = 无条件 hardcoded 中文, 必修
 *
 * 跑法: node tools/i18n_audit.js          (打印报告)
 *       node tools/i18n_audit.js --count  (只打印 HARD 计数, CI 用; 退出码=HARD数)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'Wiltek_V2.html');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

const HAN = /[一-鿿]/;
const HAN_RUN = /[一-鿿][一-鿿＀-￯0-9A-Za-z %·×÷／/().,:：、。!?！？\-—~+]*/g;

// 1) 找 <script> 区
let scriptStart = lines.findIndex(l => /<script>/.test(l));
let scriptEnd   = lines.findIndex((l, i) => i > scriptStart && /<\/script>/.test(l));
if (scriptStart < 0) scriptStart = 0;
if (scriptEnd < 0)   scriptEnd = lines.length - 1;

// 2) 找 i18n dict 对象范围 (brace-count from `window.i18n = {`)
let dictStart = lines.findIndex(l => /window\.i18n\s*=\s*\{/.test(l));
let dictEnd = -1;
if (dictStart >= 0) {
  let depth = 0, started = false;
  for (let i = dictStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth === 0) { dictEnd = i; break; }
  }
}

function inDict(i) { return dictStart >= 0 && i >= dictStart && i <= dictEnd; }
function isConsole(line) { return /console\.(log|warn|error|info)/.test(line); }

// Strip /* */ block comments (stateful across lines) and // line comments,
// while PRESERVING string-literal contents (where user-facing 中文 lives).
let inBlock = false;
function stripComments(line) {
  let code = '', j = 0, quote = null;
  while (j < line.length) {
    const c = line[j], c2 = line[j + 1];
    if (inBlock) {
      if (c === '*' && c2 === '/') { inBlock = false; j += 2; continue; }
      j++; continue;
    }
    if (quote) {
      code += c;
      if (c === '\\') { code += (c2 || ''); j += 2; continue; }
      if (c === quote) quote = null;
      j++; continue;
    }
    if (c === '/' && c2 === '*') { inBlock = true; j += 2; continue; }
    if (c === '/' && c2 === '/') break;            // line comment → ignore rest
    if (c === "'" || c === '"' || c === '`') { quote = c; code += c; j++; continue; }
    code += c; j++;
  }
  return code;
}

const findings = [];
for (let i = scriptStart; i <= scriptEnd; i++) {
  const code = stripComments(lines[i]);          // advances inBlock state
  if (inDict(i)) continue;
  if (!HAN.test(code)) continue;
  if (isConsole(code)) continue;
  const runs = (code.match(HAN_RUN) || []).map(s => s.trim()).filter(Boolean);
  const ternary = /i18n\.lang|lang\s*===/.test(code);
  findings.push({
    line: i + 1,
    kind: ternary ? 'TERNARY' : 'HARD',
    han: [...new Set(runs)],
    ctx: lines[i].trim().slice(0, 120),
  });
}

const hard = findings.filter(f => f.kind === 'HARD');
const tern = findings.filter(f => f.kind === 'TERNARY');

if (process.argv.includes('--count')) {
  console.log('HARD=' + hard.length + ' TERNARY=' + tern.length);
  process.exit(hard.length === 0 ? 0 : 1);
}

console.log('=== i18n audit: ' + FILE + ' ===');
console.log('script lines ' + (scriptStart + 1) + '-' + (scriptEnd + 1)
  + ' | dict lines ' + (dictStart + 1) + '-' + (dictEnd + 1));
console.log('HARD (必修) = ' + hard.length + '   TERNARY (grandfathered) = ' + tern.length + '\n');

console.log('───── HARD (无条件中文, 必修) ─────');
for (const f of hard) {
  console.log(`L${f.line} | ${f.han.join(' / ')}\n        ${f.ctx}`);
}
console.log('\n───── TERNARY (language-conditional, 可选改 t()) ─────');
for (const f of tern) {
  console.log(`L${f.line} | ${f.han.join(' / ')}\n        ${f.ctx}`);
}
