// BRO-3108: llm-ensemble-score.yml must dispatch its rebuild only when the
// review-texts push actually pushed. has_changes alone is true on every run
// (scoring-progress.json is always rewritten), so runs that logged "No
// review-texts changes to push" still dispatched rebuild-fast (38399219408).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/llm-ensemble-score.yml'), 'utf8'));
const action = yaml.load(fs.readFileSync(path.join(ROOT, '.github/actions/push-review-texts/action.yml'), 'utf8'));
const steps = Object.values(wf.jobs).flatMap(j => j.steps || []);

test('push-review-texts exposes a pushed output from an id-ed step', () => {
  assert.equal(action.outputs.pushed.value, '${{ steps.push.outputs.pushed }}');
  const step = action.runs.steps.find(s => s.id === 'push');
  assert.ok(step, 'composite step with id: push');
  // Every successful git push path records pushed=true before exiting.
  const pushes = (step.run.match(/if git(?:_net \d+)? push origin main/g) || []).length; // git_net: BRO-5261
  const marks = (step.run.match(/echo "pushed=true" >> "\$GITHUB_OUTPUT"/g) || []).length;
  assert.ok(pushes >= 2);
  assert.equal(marks, pushes);
});

test('auto-trigger rebuild is gated on the review-texts push having pushed', () => {
  const push = steps.find(s => s.name === 'Push review-texts to private repo');
  const rebuild = steps.find(s => s.name === 'Auto-trigger rebuild for non-chain runs');
  assert.equal(push.id, 'push-review-texts');
  assert.match(rebuild.if, /steps\.push-review-texts\.outputs\.pushed == 'true'/);
  assert.ok(steps.indexOf(push) < steps.indexOf(rebuild), 'push runs before the rebuild dispatch');
});

// BRO-5308: the other review-text writers that dispatched rebuild-reviews.yml
// unconditionally (82 full rebuilds on 2026-10-13). Each dispatch now also
// requires push-review-texts to report pushed == 'true'. Not converted:
// collect-outlet-reviews.yml's scheduled `rebuild` job (separate post-matrix
// job, 1 dispatch/week) and dispatchers already gated on their own signal.
const { MARKER_NAME, reviewTextsPushedMarkerPath, markReviewTextsPushed } =
  require('../../scripts/lib/review-texts-pushed-marker.js');

const GATED = [
  ['collect-outlet-reviews.yml', 'Trigger rebuild', 'collect-manual'],
  ['discover-regional-serp-reviews.yml', 'Trigger rebuild'],
  ['discover-tour-stop-reviews.yml', 'Trigger rebuild'],
  ['overnight-collect.yml', 'Trigger reviews rebuild'],
  ['backfill-review-dates.yml', 'Trigger rebuild'],
  ['backfill-meta-evidence.yml', 'Trigger rebuild'],
  ['audit-touring-contamination.yml', 'Trigger rebuild'],
  ['recover-wayback-reviews.yml', 'Trigger rebuild'],
  ['collect-we-ob-reviews.yml', 'Trigger rebuild'],
  ['drain-not-attempted.yml', 'Trigger rebuild if recoveries'],
];

for (const [file, dispatchName, jobName] of GATED) {
  test(`${file}: rebuild dispatch gated on push-review-texts pushed`, () => {
    const w = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8'));
    const jobs = jobName ? [w.jobs[jobName]] : Object.values(w.jobs);
    const job = jobs.find(j => (j.steps || []).some(s => s.name === dispatchName));
    assert.ok(job, `job with step "${dispatchName}"`);
    const push = job.steps.find(s => s.uses === './.github/actions/push-review-texts');
    const rebuild = job.steps.find(s => s.name === dispatchName);
    assert.equal(push.id, 'push-review-texts');
    assert.match(String(rebuild.if), /steps\.push-review-texts\.outputs\.pushed == 'true'/);
    assert.match(rebuild.run, /gh workflow run (rebuild-reviews\.yml|"Rebuild Reviews Data")/);
    assert.ok(job.steps.indexOf(push) < job.steps.indexOf(rebuild), 'push runs before the dispatch');
  });
}

test('marker helper: no-op outside Actions, writes under RUNNER_TEMP', () => {
  assert.equal(reviewTextsPushedMarkerPath({}), null);
  assert.equal(markReviewTextsPushed({}), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-marker-'));
  const p = markReviewTextsPushed({ RUNNER_TEMP: dir });
  assert.equal(p, path.join(dir, MARKER_NAME));
  assert.ok(fs.existsSync(p));
  assert.equal(markReviewTextsPushed({ RUNNER_TEMP: path.join(dir, 'missing') }), null, 'fail-open');
});

test('push-review-texts reports pushed=true when the marker exists (runs the real block)', () => {
  const run = action.runs.steps.find(s => s.id === 'push').run;
  const block = run.match(/\n( *if \[ -n "\$\{RUNNER_TEMP:-\}" \][\s\S]*?\n *fi\n)/);
  assert.ok(block, 'marker block present');
  assert.ok(block[1].includes(MARKER_NAME), 'action uses the lib marker name');
  assert.ok(run.indexOf(block[1]) < run.search(/\bexit 0\b/), 'checked before any early exit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-action-'));
  const out = path.join(dir, 'out');
  const sh = (env) => { fs.writeFileSync(out, ''); execFileSync('bash', ['-c', block[1]], { env: { ...process.env, ...env, GITHUB_OUTPUT: out } }); return fs.readFileSync(out, 'utf8'); };
  assert.equal(sh({ RUNNER_TEMP: dir }), '');
  markReviewTextsPushed({ RUNNER_TEMP: dir });
  assert.equal(sh({ RUNNER_TEMP: dir }), 'pushed=true\n');
  assert.equal(sh({ RUNNER_TEMP: '' }), '');
});

test('every mid-run review-texts pushWithRetry caller drops the marker on success', () => {
  const scriptsDir = path.join(ROOT, 'scripts');
  const callers = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js'))
    .filter(f => /pushWithRetry\(\{ cwd: (rtDir|reviewTextsDir)\b/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8')));
  assert.ok(callers.length >= 4, `found ${callers.join(', ')}`);
  for (const f of callers) {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    const re = /const rtPush = pushWithRetry\(\{ cwd: (?:rtDir|reviewTextsDir)[^\n]*\n\s*if \(rtPush\.ok\) \{\n\s*markReviewTextsPushed\(\);/g;
    const calls = (src.match(/pushWithRetry\(\{ cwd: (rtDir|reviewTextsDir)\b/g) || []).length;
    assert.equal((src.match(re) || []).length, calls, `${f}: every review-texts push marks on ok`);
  }
});
