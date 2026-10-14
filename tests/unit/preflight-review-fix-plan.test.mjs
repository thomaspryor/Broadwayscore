/**
 * BRO-4849: preflight-review-fix-plan replays a plan on a throwaway copy through the real executor and write guard.
 * Run: node --test tests/unit/preflight-review-fix-plan.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preflight } = require('../../scripts/lib/preflight-review-fix-plan.js');

function fixture(files, actions, status = 'pending') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
  const rt = path.join(root, 'review-texts', 'fixture-show-2026');
  fs.mkdirSync(rt, { recursive: true });
  for (const [f, d] of Object.entries(files)) fs.writeFileSync(path.join(rt, f), JSON.stringify(d, null, 2));
  const plan = path.join(root, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ issueNumber: 'bro-test', status, plan: { actions } }));
  return { root, reviewTextsDir: path.join(root, 'review-texts'), plan, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const edit = (file, field, oldValue, newValue) => ({ type: 'review-field-edit', file: `fixture-show-2026/${file}`, field, oldValue, newValue });
const url = 'https://chicago.suntimes.com/theater/2026/06/30/fixture-review';

test('a clean plan passes, later actions see earlier writes, and the source files are never written', () => {
  const c = fixture({ 'a.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'A', url: 'https://ew.com/a', originalScore: 'B' } }, [
    edit('a.json', 'originalScore', 'B', 'B+'),
    edit('a.json', 'humanReviewScore', null, 80),
  ]);
  const before = fs.readFileSync(path.join(c.reviewTextsDir, 'fixture-show-2026', 'a.json'), 'utf8');
  try {
    const logs = [];
    assert.equal(preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) }).failed, 0, logs.join('\n'));
    assert.equal(fs.readFileSync(path.join(c.reviewTextsDir, 'fixture-show-2026', 'a.json'), 'utf8'), before);
  } finally { c.cleanup(); }
});

test('a stale oldValue and a write-guard side effect both fail (the iceboy url-collision case)', () => {
  const c = fixture({
    'first.json': { showId: 'fixture-show-2026', outletId: 'chicago-sun-times', criticName: 'First', url, fullText: 'x'.repeat(400) },
    'second.json': { showId: 'fixture-show-2026', outletId: 'chicago-sun-times', criticName: 'Second', url, fullText: 'x'.repeat(400) },
    'stale.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'S', url: 'https://ew.com/s', humanReviewScore: 50 },
  }, [
    edit('second.json', 'humanReviewScore', null, 71),
    edit('stale.json', 'humanReviewScore', 40, 60),
  ]);
  try {
    const logs = [];
    const { failed } = preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) });
    assert.equal(failed, 2, logs.join('\n'));
    assert.ok(logs.some((l) => /second\.json humanReviewScore.*duplicateOf/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /stale\.json.*doesn't match expected/.test(l)), logs.join('\n'));
  } finally { c.cleanup(); }
});

// BRO-3414: a 277-action plan passed preflight and was refused at land by the
// MAX_PLAN_ACTIONS cap; preflight now fails it up front.
test('a plan over the action cap fails preflight', () => {
  const { MAX_PLAN_ACTIONS } = require('../../scripts/lib/pending-fix-limits.js');
  const actions = Array.from({ length: MAX_PLAN_ACTIONS + 1 }, (_, i) => edit('a.json', 'humanReviewScore', i === 0 ? null : 50 + i - 1, 50 + i));
  const c = fixture({ 'a.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'A', url: 'https://ew.com/a' } }, actions);
  try {
    const logs = [];
    assert.equal(preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) }).failed, 1, logs.join('\n'));
    assert.ok(logs.some((l) => l.includes(`max ${MAX_PLAN_ACTIONS}`)), logs.join('\n'));
  } finally { c.cleanup(); }
});

test('a status the executor will not run fails here, not after the land (BRO-5015, BRO-5254 plan G)', () => {
  for (const status of ['approved', null]) {
    const c = fixture({ 'a.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'A', url: 'https://ew.com/a', originalScore: 'B' } }, [
      edit('a.json', 'originalScore', 'B', 'B+'),
    ], status);
    try {
      const logs = [];
      assert.equal(preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) }).failed, 1, logs.join('\n'));
      assert.match(logs.join('\n'), /must be "pending"/);
    } finally { c.cleanup(); }
  }
});
