// BRO-3632 / BRO-3489: posthog-monday.yml's friction-fixer job (which runs
// auto-fix-friction-card.js) was "cancelled" on every run from 2026-08-31 to
// 2026-09-28. Job logs show the actions/checkout step itself hit the 20-min job
// timeout: a full-blob fetch-depth: 0 clone takes ~24 min. BRO-4231's
// filter: blob:none fixed it (2026-10-05 run: checkout 60 s, job success).
// These assertions pin both that fix and the run-level concurrency guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wf = yaml.load(readFileSync(path.join(root, '.github/workflows/posthog-monday.yml'), 'utf8'));
const fixer = wf.jobs['friction-fixer'];

test('friction-fixer job still runs auto-fix-friction-card.js', () => {
  assert.ok(fixer, 'friction-fixer job missing');
  assert.ok(fixer.steps.some((s) => /auto-fix-friction-card\.js/.test(s.run || '')));
});

test('checkout is a blobless partial clone so it cannot eat the job timeout', () => {
  const checkout = fixer.steps.find((s) => /^actions\/checkout@/.test(s.uses || ''));
  assert.ok(checkout, 'checkout step missing');
  if (checkout.with && Number(checkout.with['fetch-depth']) === 0) {
    assert.equal(checkout.with.filter, 'blob:none', 'full-history checkout without blob:none takes ~24 min > timeout');
  }
});

test('git low-speed abort is set before checkout so a stalled transfer fails fast', () => {
  const idxAbort = fixer.steps.findIndex((s) => /http\.lowSpeedLimit/.test(s.run || ''));
  const idxCheckout = fixer.steps.findIndex((s) => /^actions\/checkout@/.test(s.uses || ''));
  assert.ok(idxAbort >= 0 && idxAbort < idxCheckout);
});

test('workflow-level concurrency queues overlapping runs without cancelling (BRO-3489)', () => {
  assert.ok(wf.concurrency, 'no concurrency block');
  assert.equal(wf.concurrency.group, 'posthog-monday');
  assert.equal(wf.concurrency['cancel-in-progress'], false);
});
