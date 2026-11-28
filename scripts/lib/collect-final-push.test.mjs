// BRO-7117: the collector's forced end-of-run main push can be left to the workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { shouldPushMainCheckpoint: f } = require('./collect-final-push.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('forced push skipped only when SKIP_FINAL_MAIN_PUSH=1', () => {
  assert.deepEqual(f({ forcePush: true, intervalDue: false, hasPendingCommit: true, env: { SKIP_FINAL_MAIN_PUSH: '1' } }), { push: false, reason: 'final-push-left-to-workflow' });
  assert.equal(f({ forcePush: true, intervalDue: false, hasPendingCommit: true, env: {} }).push, true);
  assert.equal(f({ forcePush: true, intervalDue: false, hasPendingCommit: true, env: { SKIP_FINAL_MAIN_PUSH: '0' } }).push, true);
});

test('interval pushes unchanged by the flag; nothing pending never pushes', () => {
  assert.equal(f({ forcePush: false, intervalDue: true, hasPendingCommit: true, env: { SKIP_FINAL_MAIN_PUSH: '1' } }).push, true);
  assert.equal(f({ forcePush: false, intervalDue: false, hasPendingCommit: true, env: {} }).push, false);
  assert.equal(f({ forcePush: true, intervalDue: true, hasPendingCommit: false, env: {} }).push, false);
});

test('poller sets the flag on collect AND pushes the checkpoint in a later step', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8');
  const collect = y.indexOf('- name: Collect full text inline');
  const push = y.indexOf('- name: Push collect checkpoint');
  assert.ok(collect > 0 && push > collect, 'Push collect checkpoint must follow the collect step');
  assert.match(y.slice(collect, push), /SKIP_FINAL_MAIN_PUSH: '1'/);
  assert.match(y.slice(push, push + 900), /push-with-retry\.sh/);
  assert.ok(fs.readFileSync(path.join(ROOT, 'scripts/collect-review-texts.js'), 'utf8').includes("require('./lib/collect-final-push')"), 'collector must use the helper');
});
