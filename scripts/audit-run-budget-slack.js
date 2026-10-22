#!/usr/bin/env node
/**
 * Ratchet for BRO-5338: scripts whose loop head checks only
 * `budget.exceeded()` run out the clock. exceeded() lets an item start with
 * 1ms left, so the worst item must fit in the slack between
 * --time-budget-min and the workflow's timeout-minutes. Scripts that can
 * overrun that slack use `canStartItem(MIN_REMAINING_MS_TO_START)` with an
 * inline reserve justification instead (scripts/lib/run-budget.js).
 *
 * Every exceeded()-only script existing on 2026-10-22 was audited (step slack
 * >= 3 min for all but the three converted ones) and is listed in
 * scripts/lib/run-budget-slack-baseline.json. A NEW exceeded()-only script
 * must either use canStartItem or carry `// run-budget-slack-ok: <reason>`
 * (reason = why its worst item fits the workflow slack). Advisory: exit 0
 * unless --strict.
 *
 *   node scripts/audit-run-budget-slack.js [--strict] [--list]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'lib', 'run-budget-slack-baseline.json');

function scanText(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const usesExceeded = /\.exceeded\(\)/.test(code);
  const usesCanStart = /\.canStartItem\(/.test(code);
  const waived = /run-budget-slack-ok:\s*\S.{14,}/.test(text);
  return { exceededOnly: usesExceeded && !usesCanStart, waived };
}

function listScripts(root = ROOT) {
  const out = [];
  for (const dir of ['scripts', 'scripts/lib']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'run-budget.js') out.push(`${dir}/${f}`);
    }
  }
  return out.sort();
}

function findExceededOnly(root = ROOT) {
  return listScripts(root).filter((rel) => {
    const r = scanText(fs.readFileSync(path.join(root, rel), 'utf8'));
    return r.exceededOnly && !r.waived;
  });
}

function loadBaseline(file = BASELINE) {
  try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8')).files); } catch { return new Set(); }
}

function newFindings(found, baseline) {
  return found.filter((f) => !baseline.has(f));
}

module.exports = { scanText, listScripts, findExceededOnly, loadBaseline, newFindings };

if (require.main === module) {
  const found = findExceededOnly();
  if (process.argv.includes('--list')) { console.log(found.join('\n')); process.exit(0); }
  const fresh = newFindings(found, loadBaseline());
  console.log(`run-budget slack: ${found.length} exceeded()-only scripts, ${fresh.length} new`);
  for (const f of fresh) {
    console.log(`::warning file=${f}::exceeded()-only loop head: use canStartItem(MIN_REMAINING_MS_TO_START) with a reserve justification, or add "// run-budget-slack-ok: <why the worst item fits the workflow slack>"`);
  }
  process.exit(fresh.length && process.argv.includes('--strict') ? 1 : 0);
}
