// BRO-7559: a pass on a re-pointed test never auto-closes; stale checks go to a worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideAutoClose } = require('./autonomous-recheck-core.js');
const { decideHandoff } = require('./recheck-handoff.js');

const card = { id: 'BRO-1', status: 'Backlog', stateType: 'backlog', notes: 'RECHECK-AFTER: 2026-11-01', comments: [] };
const target = { cardId: 'BRO-1', verifyCmd: 'node --test old/a.test.mjs' };

test('moved-test pass does not auto-close', () => {
  const v = decideAutoClose({ card, target, result: { status: 'pass', detail: 'check is stale (moved a -> b)', staleCheck: { kind: 'moved' } }, now: new Date('2026-11-15') });
  assert.equal(v.close, false);
  assert.match(v.reason, /^stale check/);
});

test('stale checks are handed to a worker', () => {
  assert.equal(decideHandoff({ card, target, result: { status: 'unverifiable', cause: 'missing-path', detail: 'check is stale: x' } }).reason, 'stale-check');
  assert.equal(decideHandoff({ card, target, result: { status: 'unverifiable', cause: 'whole-suite' } }).reason, 'stale-check');
  assert.equal(decideHandoff({ card, target, result: { status: 'unverifiable', cause: 'moved-fail' } }).reason, 'stale-check');
  assert.equal(decideHandoff({ card, target, result: { status: 'pass' }, closeVerdict: { close: false, reason: 'stale check: passed on a re-pointed test' } }).reason, 'stale-check');
  assert.equal(decideHandoff({ card, target, result: { status: 'unverifiable', cause: 'timeout' } }).handoff, false);
});
