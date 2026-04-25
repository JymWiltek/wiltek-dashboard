/**
 * Wiltek Portal — final QA report enrichment.
 *
 * Reads:
 *   tests/qa-findings.json    — accumulated findings from the spec run
 *   tests/playwright-report.json — totals + per-test status from Playwright
 *   git log                   — commits since the QA branch started
 *
 * Writes:
 *   tests/qa-report.md         — richly formatted summary with totals,
 *                                 passes, fixed-bugs (with commit hashes)
 *                                 and "需 Jym 决定" decision items.
 *
 * Invoked via `posttest:e2e` so it runs once per matrix.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT          = path.resolve(__dirname, '..');
const FINDINGS_PATH = path.join(__dirname, 'qa-findings.json');
const PW_REPORT     = path.join(__dirname, 'playwright-report.json');
const REPORT_PATH   = path.join(__dirname, 'qa-report.md');

function safeJSON(p, fallback){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function git(cmd){
  try { return execSync('git -C ' + JSON.stringify(ROOT) + ' ' + cmd, { encoding:'utf8' }).trim(); }
  catch { return ''; }
}

// ── Test totals ──────────────────────────────────────────────────────
function walkSuites(suites, acc){
  for (const s of suites || []){
    for (const sp of s.specs || []){
      for (const t of sp.tests || []){
        for (const r of t.results || []){
          acc.total++;
          if (r.status === 'passed') acc.passed++;
          else if (r.status === 'skipped') acc.skipped++;
          else acc.failed++;
        }
      }
    }
    if (s.suites) walkSuites(s.suites, acc);
  }
}

function tallyTests(){
  const pw = safeJSON(PW_REPORT, null);
  if (!pw) return { total:0, passed:0, failed:0, skipped:0, durationMs:0 };
  const acc = { total:0, passed:0, failed:0, skipped:0, durationMs: pw.stats?.duration || 0 };
  walkSuites(pw.suites, acc);
  return acc;
}

// ── Fixed-bug commits ────────────────────────────────────────────────
//
// We surface every commit since the QA harness was introduced (the first
// "Wave 1 Step 3" commit) whose subject mentions a fix or matches a
// known bug rule keyword. Output is one row per commit with the short
// hash + subject.
function fixedBugCommits(){
  const log = git("log --pretty=format:'%h%x09%s' -n 60");
  if (!log) return [];
  const lines = log.split('\n').map(l => {
    const i = l.indexOf('\t');
    return { hash: l.slice(0, i), subject: l.slice(i+1) };
  });
  // Find anchor: oldest "Wave 1 Step 3" commit. git log is newest-first,
  // so the LAST matching index is the anchor; everything from HEAD down
  // to it is in scope.
  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--){
    if (/wave\s*1\s*step\s*3/i.test(lines[i].subject)){ anchorIdx = i; break; }
  }
  const since = anchorIdx >= 0 ? lines.slice(0, anchorIdx + 1) : lines;
  return since.filter(c =>
    /\b(fix|hotfix|harden|guard|repair|patch)\b/i.test(c.subject) ||
    /Wave\s*1\s*Step\s*3/i.test(c.subject)
  );
}

// ── Decision items ───────────────────────────────────────────────────
//
// Findings whose detail mentions "需 Jym 决定" or that flag data gaps —
// those don't block sign-off but Jym should resolve them. None today;
// kept here so the section is present for future runs.
function decisionItems(findings){
  return findings.filter(f =>
    /jym|decision|需\s*jym|data\s*gap|missing\s*data/i.test(f.detail || ''));
}

// ── Render ───────────────────────────────────────────────────────────
function fmtMs(ms){
  const s = Math.round(ms/1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s/60)}m ${s%60}s`;
}

function renderReport(){
  const findings = safeJSON(FINDINGS_PATH, []);
  const tally    = tallyTests();
  const fixes    = fixedBugCommits();
  const decisions = decisionItems(findings);

  const lines = [];
  lines.push('# Wiltek Portal — QA Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Top-level summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Tests run**: ${tally.total}`);
  lines.push(`- **Passed**: ${tally.passed}`);
  lines.push(`- **Failed**: ${tally.failed}`);
  lines.push(`- **Skipped**: ${tally.skipped}`);
  lines.push(`- **Duration**: ${fmtMs(tally.durationMs)}`);
  lines.push(`- **Findings**: ${findings.length}`);
  lines.push(`- **Decision items (需 Jym 决定)**: ${decisions.length}`);
  lines.push('');

  // Findings — A / B / C
  const byLayer = (l) => findings.filter(f => f.layer === l);
  const sections = [
    ['A', 'A. Functional'],
    ['B', 'B. UX checklist'],
    ['C', 'C. Visual consistency'],
  ];
  for (const [k, label] of sections){
    const list = byLayer(k);
    lines.push(`## ${label} — ${list.length} finding${list.length===1?'':'s'}`);
    if (list.length === 0){ lines.push(''); lines.push('_No issues._'); lines.push(''); continue; }
    lines.push('');
    lines.push('| # | Rule | Role | Page | Viewport | Lang | Detail |');
    lines.push('| - | ---- | ---- | ---- | -------- | ---- | ------ |');
    list.forEach((f, i) => {
      const detail = (f.detail || '').replace(/\n/g, ' ').replace(/\|/g, '\\|').slice(0, 220);
      lines.push(`| ${i+1} | ${f.rule} | ${f.role||'-'} | ${f.page||'-'} | ${f.viewport||'-'} | ${f.lang||'-'} | ${detail} |`);
    });
    lines.push('');
  }

  // Fixed-bug commits
  lines.push('## Fixes during this QA pass');
  lines.push('');
  if (fixes.length === 0){
    lines.push('_No fix commits found in the recent log._');
    lines.push('');
  } else {
    lines.push('| Commit | Subject |');
    lines.push('| ------ | ------- |');
    fixes.forEach(c => {
      const subj = c.subject.replace(/\|/g, '\\|');
      lines.push(`| \`${c.hash}\` | ${subj} |`);
    });
    lines.push('');
  }

  // Decision items
  lines.push('## 需 Jym 决定');
  lines.push('');
  if (decisions.length === 0){
    lines.push('_None — no data-gap or business-decision items raised by this pass._');
    lines.push('');
  } else {
    lines.push('| # | Rule | Detail |');
    lines.push('| - | ---- | ------ |');
    decisions.forEach((f, i) => {
      lines.push(`| ${i+1} | ${f.rule} | ${(f.detail||'').replace(/\|/g,'\\|')} |`);
    });
    lines.push('');
  }

  // Footer — environment
  lines.push('---');
  lines.push('');
  lines.push(`Branch \`${git('rev-parse --abbrev-ref HEAD') || '?'}\` @ \`${git('rev-parse --short HEAD') || '?'}\``);
  lines.push('');

  return lines.join('\n');
}

const md = renderReport();
fs.writeFileSync(REPORT_PATH, md, 'utf8');
console.log(`\n=== Final QA report written to ${REPORT_PATH} ===\n`);
