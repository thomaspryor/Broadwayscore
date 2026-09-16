// Colocated tests for the content-aware should-deploy gate (vercel-deploy.yml).
// Runs in the scripts/lib/*.test.mjs glob batch in test.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, classifyDiffExit, SITE_PATHS, STALENESS_BACKSTOP_SEC } = require('./should-deploy-gate.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const base = {
  eventName: 'schedule',
  gateDisabled: false,
  baselineSha: A,
  deployAgeSec: 600,
  headSha: B,
  diffResult: 'clean',
};

test('schedule: baseline == HEAD skips (no-new-commits)', () => {
  const r = decide({ ...base, headSha: A });
  assert.deepEqual(r, { proceed: false, reason: 'no-new-commits' });
});

test('schedule: unknown baseline fails OPEN (deploys)', () => {
  const r = decide({ ...base, baselineSha: null });
  assert.equal(r.proceed, true);
  assert.equal(r.reason, 'no-baseline-fail-open');
});

test('schedule: clean site diff + fresh deploy skips (content-gate)', () => {
  const r = decide({ ...base });
  assert.deepEqual(r, { proceed: false, reason: 'content-gate' });
});

test('schedule: dirty site diff deploys (content-changed)', () => {
  const r = decide({ ...base, diffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'content-changed' });
});

test('schedule: staleness backstop fires at >6h even with clean diff (seconds math)', () => {
  // check-prod-deploy.js --json returns ageSec (already converted from Vercel's
  // epoch-ms createdAt) — assert exact-boundary semantics so an ms/sec mixup or
  // an off-by-one can never silently disable the backstop.
  const atBoundary = decide({ ...base, deployAgeSec: STALENESS_BACKSTOP_SEC });
  assert.equal(atBoundary.proceed, false, '6h exactly is NOT stale');
  const past = decide({ ...base, deployAgeSec: STALENESS_BACKSTOP_SEC + 1 });
  assert.deepEqual(past, { proceed: true, reason: 'staleness-backstop' });
  assert.equal(STALENESS_BACKSTOP_SEC, 21600);
});

test('schedule: unknown deploy age fails OPEN', () => {
  const r = decide({ ...base, deployAgeSec: null });
  assert.deepEqual(r, { proceed: true, reason: 'no-age-fail-open' });
});

test('schedule: diff error fails OPEN', () => {
  for (const diffResult of ['error', null, undefined]) {
    const r = decide({ ...base, diffResult });
    assert.equal(r.proceed, true, `diffResult=${diffResult} must fail open`);
  }
});

test('workflow_dispatch: proceeds unless SHA already live', () => {
  assert.deepEqual(
    decide({ ...base, eventName: 'workflow_dispatch', diffResult: null }),
    { proceed: true, reason: 'explicit-ship' }
  );
  // 'already-live' dedup requires a POSITIVELY clean data signal — see the
  // BRO-3149 code-review fix test below for the unknown-signal case.
  assert.deepEqual(
    decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult: 'clean' }),
    { proceed: false, reason: 'already-live' }
  );
});

test('workflow_dispatch: Vercel API down still ships (no dedup possible)', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', baselineSha: null, deployAgeSec: null });
  assert.equal(r.proceed, true);
});

test('workflow_run: same semantics as dispatch', () => {
  assert.equal(decide({ ...base, eventName: 'workflow_run' }).proceed, true);
  assert.equal(decide({ ...base, eventName: 'workflow_run', headSha: A, dataDiffResult: 'clean' }).proceed, false);
});

// Codex adversarial /code-review (BRO-3149, post-merge): the non-schedule
// dedup branch used to treat an UNKNOWN dataDiffResult exactly like a
// positively-clean one and skip — reproducing the original bug via the
// workflow_run/workflow_dispatch lane instead of the schedule lane (this is
// the trigger rebuild-fast.yml's direct post-push dispatch uses, arguably
// the highest-value path for this fix). Unknown status must fail OPEN here,
// unlike the schedule branch (which has an age-gated backstop to lean on
// instead of a blanket fail-open).
test('workflow_dispatch: HEAD already live, data status UNKNOWN — fails open (does not silently dedup)', () => {
  for (const dataDiffResult of ['error', null, undefined]) {
    const r = decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult });
    assert.deepEqual(r, { proceed: true, reason: 'data-unknown-fail-open' });
  }
});

test('workflow_run: HEAD already live, data status UNKNOWN — fails open (same lane rebuild-fast.yml dispatches through)', () => {
  const r = decide({ ...base, eventName: 'workflow_run', headSha: A, dataDiffResult: 'error' });
  assert.deepEqual(r, { proceed: true, reason: 'data-unknown-fail-open' });
});

// BRO-3149: reviews.json/shows.json live in the private core-data repo and
// never touch this repo's git tree, so the site-path diff alone is blind to
// a core-data-only change. dataDiffResult carries that signal in separately —
// see should-deploy-gate.js header comment for the full incident writeup.
test('schedule: core data advanced but web HEAD did not — still proceeds (data-changed)', () => {
  const r = decide({ ...base, diffResult: 'clean', dataDiffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'data-changed' });
});

test('schedule: baseline == HEAD but core data advanced — still proceeds (data-changed)', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'data-changed' });
});

test('schedule: neither site nor core data changed — skips (content-gate)', () => {
  const r = decide({ ...base, diffResult: 'clean', dataDiffResult: 'clean' });
  assert.deepEqual(r, { proceed: false, reason: 'content-gate' });
});

test('schedule: data diff lookup unavailable falls through to site-diff signal unchanged', () => {
  for (const dataDiffResult of ['error', null, undefined]) {
    const clean = decide({ ...base, diffResult: 'clean', dataDiffResult });
    assert.deepEqual(clean, { proceed: false, reason: 'content-gate' });
    const dirty = decide({ ...base, diffResult: 'dirty', dataDiffResult });
    assert.deepEqual(dirty, { proceed: true, reason: 'content-changed' });
  }
});

test('workflow_dispatch: already-live dedup still fires when core data has NOT advanced', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult: 'clean' });
  assert.deepEqual(r, { proceed: false, reason: 'already-live' });
});

test('workflow_dispatch: HEAD already live but core data advanced — proceeds (data-changed)', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'data-changed' });
});

// Codex adversarial review (BRO-3149): the `baselineSha === headSha` branch
// used to return before the staleness-backstop age check ever ran. A
// persistently-broken data lookup (missing token, API outage) combined with
// a genuinely idle public repo could therefore strand core-data staleness
// indefinitely — the ONE case in this file where an unknown signal used to
// bypass the 6h backstop entirely rather than falling back to it.
test('schedule: baseline == HEAD, data status unknown, deploy is stale — backstop still fires', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'error', deployAgeSec: STALENESS_BACKSTOP_SEC + 1 });
  assert.deepEqual(r, { proceed: true, reason: 'staleness-backstop' });
});

test('schedule: baseline == HEAD, data status unknown, deploy is fresh — still skips (no false proceed)', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'error', deployAgeSec: 600 });
  assert.deepEqual(r, { proceed: false, reason: 'no-new-commits' });
});

test('schedule: baseline == HEAD, data positively clean, deploy is stale — skips WITHOUT checking age (genuine no-op)', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'clean', deployAgeSec: STALENESS_BACKSTOP_SEC + 1 });
  assert.deepEqual(r, { proceed: false, reason: 'no-new-commits' });
});

test('kill switch forces proceed on every event, even baseline==HEAD', () => {
  for (const eventName of ['schedule', 'workflow_dispatch', 'workflow_run']) {
    const r = decide({ ...base, eventName, gateDisabled: true, headSha: A });
    assert.deepEqual(r, { proceed: true, reason: 'kill-switch' });
  }
});

test('classifyDiffExit: 0=clean, 1=dirty, anything else=error', () => {
  assert.equal(classifyDiffExit(0), 'clean');
  assert.equal(classifyDiffExit(1), 'dirty');
  assert.equal(classifyDiffExit(2), 'error');
  assert.equal(classifyDiffExit(128), 'error');
});

test('SITE_PATHS keeps its load-bearing entries', () => {
  // public/ carries the rebuilt public/data/shows/*.json (review scores);
  // scripts/ carries prebuild scripts; content/ carries content/reviews.
  // Removing one silently narrows the gate (pre-mortem scenario 2).
  for (const p of ['src/', 'public/', 'content/', 'scripts/', 'package.json', 'next.config.js']) {
    assert.ok(SITE_PATHS.includes(p), `SITE_PATHS must include ${p}`);
  }
});
