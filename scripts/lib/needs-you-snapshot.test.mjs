import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNeedsYouTitle, isEmptyDecisionContent, pendingDecisions } = require('./needs-you-snapshot.js');

test('isNeedsYouTitle: leading ❓ (within the glyph zone) counts, later ❓ does not', () => {
  assert.equal(isNeedsYouTitle('❓ Fix the thing'), true);
  assert.equal(isNeedsYouTitle('⠂ ❓ Fix the thing'), true); // spinner glyph prefix, like isDoneTitle
  assert.equal(isNeedsYouTitle('Fix the thing'), false);
  assert.equal(isNeedsYouTitle('A question mark ❓ later in the title'), false);
});

test('pendingDecisions: only surfaces states whose LIVE title still carries ❓', () => {
  const states = [
    { ref: 'workspace:1', question: 'ship v2 or wait?', ts: '2026-08-02T10:00:00Z' },
    { ref: 'workspace:2', question: 'stale, already resolved', ts: '2026-08-02T09:00:00Z' },
    { ref: 'workspace:3', question: 'tab was closed', ts: '2026-08-02T08:00:00Z' },
  ];
  const workspaces = [
    { ref: 'workspace:1', title: '❓ Fix the thing' },
    { ref: 'workspace:2', title: '✅ Fix the thing' }, // resolved — title no longer ❓
    // workspace:3 absent — tab closed
  ];
  const pending = pendingDecisions(states, workspaces);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ref, 'workspace:1');
  assert.equal(pending[0].title, '❓ Fix the thing');
  assert.equal(pending[0].question, 'ship v2 or wait?');
});

test('pendingDecisions: malformed/refless states are skipped, not thrown', () => {
  assert.deepEqual(pendingDecisions([null, {}, { ref: 'workspace:9' }], []), []);
});

test('isEmptyDecisionContent: recognizes stub "none"-shaped extractions (card #940)', () => {
  assert.equal(isEmptyDecisionContent('none — no pending decision, omitting the block entirely'), true);
  assert.equal(isEmptyDecisionContent('None.'), true);
  assert.equal(isEmptyDecisionContent('n/a'), true);
  assert.equal(isEmptyDecisionContent('nothing pending'), true);
  assert.equal(isEmptyDecisionContent('no pending decision'), true);
  assert.equal(isEmptyDecisionContent('no decision needed'), true);
  assert.equal(isEmptyDecisionContent(''), true);
  assert.equal(isEmptyDecisionContent(null), true);
});

test('isEmptyDecisionContent: a real question is never treated as empty, even one that starts with a stub-shaped phrase (ship-check adversarial finding, 2026-08-03)', () => {
  assert.equal(isEmptyDecisionContent('ship v2 or wait?'), false);
  assert.equal(isEmptyDecisionContent('none of the 3 vendors quoted under budget — proceed anyway?'), false);
  assert.equal(isEmptyDecisionContent('No decision has been made about vendor X — should we wait?'), false);
  assert.equal(isEmptyDecisionContent('no decision needed right now, but flag it for next sprint planning'), false);
});

test('pendingDecisions: excludes a ❓-titled tab whose extracted question is a "none" stub (card #940)', () => {
  const states = [
    { ref: 'workspace:1', question: 'ship v2 or wait?', ts: '2026-08-03T07:00:00Z' },
    { ref: 'workspace:2', question: 'none — no pending decision, omitting the block entirely rather than a stub line', ts: '2026-08-03T07:47:00Z' },
  ];
  const workspaces = [
    { ref: 'workspace:1', title: '❓ Fix the thing' },
    { ref: 'workspace:2', title: '❓ Some other tab' },
  ];
  const pending = pendingDecisions(states, workspaces);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ref, 'workspace:1');
});
