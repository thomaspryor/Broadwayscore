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
  assert.deepEqual(
    decide({ ...base, eventName: 'workflow_dispatch', headSha: A }),
    { proceed: false, reason: 'already-live' }
  );
});

test('workflow_dispatch: Vercel API down still ships (no dedup possible)', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', baselineSha: null, deployAgeSec: null });
  assert.equal(r.proceed, true);
});

test('workflow_run: same semantics as dispatch', () => {
  assert.equal(decide({ ...base, eventName: 'workflow_run' }).proceed, true);
  assert.equal(decide({ ...base, eventName: 'workflow_run', headSha: A }).proceed, false);
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
