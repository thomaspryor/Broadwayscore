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

test('collapseCrownLineages: folds sequential crown generations of the same lineage into one row, annotated with age + count (BRO-2989)', () => {
  const { collapseCrownLineages, formatDetail } = require('./needs-you-snapshot.js');
  const pending = [
    { ref: 'workspace:83', title: '❓ 👑 OWNER — Crown v25: P1 backlog triage + dispatch loop', question: 'Cancel the Cyrus Team Cloud subscription at $120/mo?', ts: '2026-09-01T01:04:39.663Z' },
    { ref: 'workspace:140', title: '❓ 👑 OWNER — Crown v33: P1 backlog dispatch + triage', question: 'What happens to the 26 stranded iOS overnight branches?', ts: '2026-09-05T16:21:20.420Z' },
    { ref: 'workspace:117', title: '❓ 👑 OWNER — Crown v45 (BRO-343 backlog triage + dispatch loop)', question: 'Pick a date for the Forbes/Marc Hershberg walkthrough.', ts: '2026-09-08T01:04:51.886Z' },
    { ref: 'workspace:116', title: '❓ Scraper cost: SD breaker ceiling fix (BRO-2943)', question: 'Go with the revised four-sprint plan?', ts: '2026-09-08T01:05:15.062Z' },
  ];
  const collapsed = collapseCrownLineages(pending);
  // 3 crown generations of the SAME lineage collapse to 1; the unrelated
  // non-crown ❓ tab passes through untouched.
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed.filter(c => c.ref === 'workspace:83' || c.ref === 'workspace:140').length, 0, 'superseded crown generations must not survive as their own rows');
  const crownRow = collapsed.find(c => c.ref === 'workspace:117');
  assert.ok(crownRow, 'latest (highest-version) generation is kept, not an older one');
  assert.equal(crownRow.supersededCount, 2);
  assert.equal(crownRow.pendingSinceTs, '2026-09-01T01:04:39.663Z');
  const detail = formatDetail(crownRow);
  assert.match(detail, /pending since 2026-09-01/);
  assert.match(detail, /3 crown generations/);
  const nonCrownRow = collapsed.find(c => c.ref === 'workspace:116');
  assert.equal(nonCrownRow.supersededCount, undefined);
  assert.equal(formatDetail(nonCrownRow), 'Go with the revised four-sprint plan?');
});

test('collapseCrownLineages: a lone crown generation with no predecessor is untouched (no false age annotation)', () => {
  const { collapseCrownLineages, formatDetail } = require('./needs-you-snapshot.js');
  const pending = [
    { ref: 'workspace:1', title: '❓ 👑 OWNER — Crown v50: BRO-343 P1 triage', question: 'ship or wait?', ts: '2026-09-08T02:00:00.000Z' },
  ];
  const collapsed = collapseCrownLineages(pending);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].supersededCount, 0);
  assert.equal(formatDetail(collapsed[0]), 'ship or wait?');
});

test('collapseCrownLineages: a falsy ts on one crown item never corrupts pendingSinceTs (ship-check finding, BRO-2989)', () => {
  const { collapseCrownLineages } = require('./needs-you-snapshot.js');
  const pending = [
    { ref: 'workspace:1', title: '❓ 👑 OWNER — Crown v10: BRO-343 P1 triage', question: 'a', ts: undefined },
    { ref: 'workspace:2', title: '❓ 👑 OWNER — Crown v11: BRO-343 P1 triage', question: 'b', ts: '2026-09-01T00:00:00.000Z' },
    { ref: 'workspace:3', title: '❓ 👑 OWNER — Crown v12: BRO-343 P1 triage', question: 'c', ts: '2026-09-05T00:00:00.000Z' },
  ];
  const collapsed = collapseCrownLineages(pending);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].pendingSinceTs, '2026-09-01T00:00:00.000Z');
});
