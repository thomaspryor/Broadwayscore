/**
 * sweep-open-backlog-acceptance-scheduled.test.mjs — BRO-3941 acceptance.
 *
 * BRO-3924's R3 wiring (linear-watchdog-source.js ineligibleReason()) reads
 * data/audit/open-backlog-acceptance-sweep.json, written only by
 * scripts/sweep-open-backlog-acceptance.js. With no scheduler that file never
 * exists and the watchdog's alreadyPasses gate is inert. The scheduled host is
 * .github/workflows/data-health-check.yml, modeled on the autonomous-
 * acceptance-recheck steps. This reads the REAL workflow text (no fixture) so
 * a future edit that drops the sweep, its budget, its isolated commit, or its
 * timeouts fails here.
 *
 * Same line-based step walker as recheck-ledger-persistence.test.mjs (no YAML
 * library is available in test.yml's lint-workflows job).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'data-health-check.yml'), 'utf8');
const lines = raw.split('\n');

const REPORT = 'data/audit/open-backlog-acceptance-sweep.json';
const SWEEP_STEP = 'Open backlog acceptance sweep (shadow mode)';
const COMMIT_STEP = 'Commit open backlog acceptance sweep';

function parseSteps(allLines) {
  const starts = [];
  for (let i = 0; i < allLines.length; i++) {
    const m = allLines[i].match(/^ {6}- name:\s*(.+?)\s*$/);
    if (m) starts.push({ name: m[1].replace(/^['"]|['"]$/g, ''), startLine: i });
  }
  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].startLine : allLines.length;
    // Drop comment lines so assertions only see real YAML, not prose that
    // mentions the same keys.
    const body = allLines.slice(s.startLine, end).filter((l) => !/^\s*#/.test(l)).join('\n');
    return { ...s, body };
  });
}

const steps = parseSteps(lines);
const idx = (name) => {
  const i = steps.findIndex((s) => s.name === name);
  assert.ok(i >= 0, `expected a step named "${name}"`);
  return i;
};
const timeoutOf = (s) => Number((s.body.match(/^ {8}timeout-minutes:\s*(\d+)/m) || [])[1]);

test('BRO-3941: a scheduled step runs the sweep script with --time-budget-min', () => {
  const step = steps[idx(SWEEP_STEP)];
  assert.ok(step, `expected a step named "${SWEEP_STEP}"`);
  assert.match(step.body, /^ {8}run:\s*(\|\s*\n\s*)?node scripts\/sweep-open-backlog-acceptance\.js\b[^\n]*--time-budget-min\s+\d+/m);
});

test('BRO-3941: the sweep step is non-blocking, always-run, and has a step timeout above its budget', () => {
  const step = steps[idx(SWEEP_STEP)];
  assert.match(step.body, /^ {8}continue-on-error:\s*true\s*$/m);
  assert.match(step.body, /^ {8}if:\s*(\$\{\{\s*)?always\(\)(\s*\}\})?\s*$/m);
  const budget = Number(step.body.match(/--time-budget-min\s+(\d+)/)[1]);
  assert.ok(timeoutOf(step) > budget, `step timeout ${timeoutOf(step)}min must exceed script budget ${budget}min`);
});

test('BRO-3941: the sweep step has LINEAR_API_KEY (the candidate fetch fails auth without it)', () => {
  assert.match(steps[idx(SWEEP_STEP)].body, /LINEAR_API_KEY:\s*\$\{\{\s*secrets\.LINEAR_API_KEY\s*\}\}/);
});

test('BRO-3941: an isolated commit step stages ONLY the sweep report and pushes via push-with-retry.sh', () => {
  const step = steps[idx(COMMIT_STEP)];
  assert.ok(step, `expected a step named "${COMMIT_STEP}"`);
  const adds = step.body.match(/git add [^\n]+/g) || [];
  assert.equal(adds.length, 1, 'exactly one git add');
  assert.equal(adds[0].replace(/\s+2>.*$|\s*\|\|.*$/, '').trim(), `git add ${REPORT}`, 'stages exactly the sweep report');
  assert.match(step.body, /git commit -m /, 'commits what it staged');
  assert.ok(!/git add (-A|--all|\.)(\s|$)/.test(step.body), 'must not bulk-stage');
  assert.match(step.body, /bash scripts\/lib\/push-with-retry\.sh\b/);
  assert.match(step.body, /git config user\.name/, 'git identity configured');
});

test('BRO-3941: the commit step is continue-on-error, always-run, with a timeout above its push deadline', () => {
  const step = steps[idx(COMMIT_STEP)];
  assert.match(step.body, /^ {8}continue-on-error:\s*true\s*$/m);
  assert.match(step.body, /^ {8}if:\s*(\$\{\{\s*)?always\(\)(\s*\}\})?\s*$/m);
  const deadline = Number(step.body.match(/PUSH_DEADLINE_SEC:\s*'(\d+)'/)[1]);
  assert.ok(timeoutOf(step) * 60 > deadline, `timeout ${timeoutOf(step)}min must exceed PUSH_DEADLINE_SEC ${deadline}s`);
  assert.match(step.body, /PUSH_API_FALLBACK_AFTER_ATTEMPTS:\s*'3'/);
});

test('BRO-3941: the commit step immediately follows the sweep step (BRO-471 ordering: no push between write and commit)', () => {
  assert.equal(idx(COMMIT_STEP), idx(SWEEP_STEP) + 1);
});

test('BRO-3941: no other step stages the sweep report (never bundled into a bulk commit)', () => {
  for (const s of steps) {
    if (s.name === COMMIT_STEP) continue;
    const staging = (s.body.match(/git add [^\n]+/g) || []).filter((l) => l.includes(REPORT) || /git add (-A|--all|\.|data\/audit\/?)(\s|$)/.test(l));
    assert.equal(staging.length, 0, `step "${s.name}" must not stage ${REPORT}`);
  }
});

test('BRO-3941: the report path the workflow commits is the one the sweep script writes', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'sweep-open-backlog-acceptance.js'), 'utf8');
  assert.match(src, /path\.join\(REPO,\s*'data',\s*'audit',\s*'open-backlog-acceptance-sweep\.json'\)/);
});

test('BRO-3941: the host workflow has a schedule trigger, so the sweep actually runs unattended', () => {
  const head = lines.slice(0, lines.findIndex((l) => /^jobs:/.test(l))).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(head, /^ {2}schedule:\s*$/m);
  assert.match(head, /^ +- cron:/m);
});
