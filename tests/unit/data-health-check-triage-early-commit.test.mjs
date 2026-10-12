/**
 * BRO-4521: data-health-check.yml left the ~40 data/audit/triage/*.json files
 * from "Run health check" dirty until the job's LAST step, so every
 * intermediate push-with-retry.sh call logged "rebase REFUSED before it
 * started: cannot rebase: You have unstaged changes" and fell through to the
 * merge fallback. The fix parks them in $RUNNER_TEMP right after the health
 * check (and again after the readmission sweep) via scripts/lib/park-triage.sh;
 * the final "Commit triage data" step puts them back.
 *
 * The park step must never push: data/audit/triage/ is not apiFallbackSafe,
 * so a stranded triage commit would disable every later apiFallbackSafe
 * step's API fallback (BRO-2538, push-with-retry.stranded-commit-cascade.test.sh).
 * Same step walker as scripts/tests/provider-spend-ledger-commit-ordering.test.mjs,
 * reading the real workflow text.
 *
 * Also pins the wrong-article audit as report-only (CLAUDE.md rule 19):
 * re-arming it is a deliberate edit to this test, not a drive-by.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lines = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'data-health-check.yml'), 'utf8').split('\n');

function parseSteps(allLines) {
  const starts = [];
  for (let i = 0; i < allLines.length; i++) {
    const m = allLines[i].match(/^ {6}- name:\s*(.+?)\s*$/);
    if (m) starts.push({ name: m[1].replace(/^['"]|['"]$/g, ''), startLine: i });
  }
  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].startLine : allLines.length;
    return { ...s, bodyText: allLines.slice(s.startLine, end).join('\n') };
  });
}

const steps = parseSteps(lines);
const idx = (name) => steps.findIndex((s) => s.name === name);

test('BRO-4521: triage data is parked right after the health check, before any push', () => {
  const health = idx('Run health check');
  const park = idx('Park triage data until the final commit');
  assert.ok(health >= 0 && park >= 0, 'both steps must exist');
  assert.equal(park, health + 1, 'the park step must be the very next step after "Run health check"');
});

test('BRO-4521: both park steps call park-triage.sh and never push', () => {
  const after = idx('Park triage data written by the readmission sweep');
  assert.equal(after, idx('unopened-show readmission-risk sweep (shadow mode)') + 1, 'parks right after the sweep that writes triage/');
  for (const name of ['Park triage data until the final commit', 'Park triage data written by the readmission sweep']) {
    const body = steps[idx(name)].bodyText.split('\n\n')[0]; // the step itself, not the next step's comment
    assert.match(body, /bash scripts\/lib\/park-triage\.sh park/);
    assert.doesNotMatch(body, /push-with-retry\.sh|git push|git commit/);
  }
  const script = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'park-triage.sh'), 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // code only
  assert.match(script, /git checkout -- "\$T"/);
  assert.match(script, /git clean -fdq -- "\$T"/);
  assert.doesNotMatch(script, /push-with-retry|git push|git commit/);
});

test('BRO-4521: final "Commit triage data" stays the last push and restores before staging', () => {
  const finalIdx = idx('Commit triage data');
  const pushers = steps.map((s, i) => (/push-with-retry\.sh/.test(s.bodyText) ? i : -1)).filter((i) => i >= 0);
  assert.equal(finalIdx, pushers[pushers.length - 1], 'it stays the last push step');
  const body = steps[finalIdx].bodyText;
  const restore = body.indexOf('park-triage.sh restore');
  const add = body.search(/^\s+git add data\/audit\/triage\//m);
  assert.ok(restore >= 0 && add > restore, 'restore must precede git add');
});

test('BRO-4521: wrong-article audit is report-only', () => {
  const step = steps[idx('wrong-article audit (report-only)')];
  assert.ok(step, 'expected the report-only wrong-article audit step');
  assert.match(step.bodyText, /continue-on-error: true/);
});
