import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BRO-2458 prevention: a script that files disposition:'auto' alert cards
// through owner-alert-router's routeAlert() must also resolve the condition
// when it clears (resolveCondition / resolveQuietConditions), or the card it
// filed stays open forever (sweep-resolved-alert-cards.js only closes cards
// whose condition the ledger shows resolved). BRO-341 fixed one script and a
// grep then found seven more with the same gap.
//
// Some alerts are one-shot EVENTS with no green state to observe. Those are
// listed here with the reason, so adding one is a deliberate decision rather
// than a silent omission. Baseline: passes on the tree it landed with, so it
// only fails for a new offender.
const EXEMPT = {
  'scripts/verify-merge-landed.js': 'one-shot: the process exits after the first failed delayed check, so it never observes the commit coming back',
  'scripts/analyze-rebuild-drops.js': 'event: drops are per-rebuild; a later clean rebuild does not bring the lost reviews back, so a resolve would let the sweep cancel a live investigation card',
  'scripts/bsc-reconcile.js': 'Mac launchd job writing the machine-local ledger that the sweep never reads, and a tick with no cmux failures is not positive evidence cmux was reached',
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIR = new Set(['node_modules', 'tests', '__tests__', 'fixtures']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), out); continue; }
    if (/\.(c|m)?[jt]s$/.test(e.name) && !/\.test\./.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// Line comments only: block comments in these scripts are prose headers and
// a rough strip is enough to stop a comment that quotes `disposition:'auto'`
// (scripts/lib/plan-ready.js does) from counting as a call.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function offenders() {
  const out = [];
  for (const abs of walk(path.join(REPO, 'scripts'))) {
    const rel = path.relative(REPO, abs).split(path.sep).join('/');
    if (rel === 'scripts/lib/owner-alert-router.js') continue;
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    if (!/\brouteAlert\(/.test(src) || !/disposition:\s*['"]auto['"]/.test(src)) continue;
    if (/\bresolve(Condition|QuietConditions)\(/.test(src)) continue;
    out.push(rel);
  }
  return out.sort();
}

test('every script filing auto alert cards resolves them, or is exempt with a reason', () => {
  const missing = offenders().filter((f) => !(f in EXEMPT));
  assert.deepEqual(missing, [], `these file disposition:'auto' alerts but never call resolveCondition()/resolveQuietConditions(): ${missing.join(', ')}. Resolve the condition where the check goes green, or add the file to EXEMPT with the reason it has no green state.`);
});

test('every exemption is still needed (the file still files auto alerts and still never resolves)', () => {
  const found = new Set(offenders());
  const stale = Object.keys(EXEMPT).filter((f) => !found.has(f));
  assert.deepEqual(stale, [], `remove these from EXEMPT: ${stale.join(', ')}`);
});
