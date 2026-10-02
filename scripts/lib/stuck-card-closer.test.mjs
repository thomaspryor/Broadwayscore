import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CLOSER_MARKER,
  cardTestPath,
  mentionsCard,
  planCandidates,
  futureRecheckAfter,
  decideClosure,
  buildClosureComment,
} = require('./stuck-card-closer.js');

const NOW = Date.parse('2026-10-02T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test('cardTestPath accepts only a single node --test file', () => {
  assert.equal(cardTestPath('node --test scripts/lib/a.test.mjs'), 'scripts/lib/a.test.mjs');
  assert.equal(cardTestPath('node --test tests/unit/b.test.js'), 'tests/unit/b.test.js');
  assert.equal(cardTestPath('node --test a.test.mjs b.test.mjs'), null);
  assert.equal(cardTestPath('node scripts/validate-data.js'), null);
  assert.equal(cardTestPath('node --test scripts/lib/a.mjs'), null);
  assert.equal(cardTestPath(undefined), null);
});

test('mentionsCard matches the exact identifier only', () => {
  assert.ok(mentionsCard('BRO-71: fix the gap', 'BRO-71'));
  assert.ok(mentionsCard('fix (BRO-71)', 'BRO-71'));
  assert.ok(!mentionsCard('BRO-710: other card', 'BRO-71'));
  assert.ok(!mentionsCard('XBRO-71 thing', 'BRO-71'));
  assert.ok(!mentionsCard('', 'BRO-71'));
});

const row = (over) => ({ id: 'BRO-1', state: 'In Review', verdict: 'STUCK', channels: ['verify-command'], cmd: 'node --test scripts/lib/one.test.mjs', ...over });

test('planCandidates refuses a stale or undated report', () => {
  assert.match(planCandidates({ generatedAt: iso(NOW - 7 * 3600e3), results: [] }, NOW).error, /7h old/);
  assert.match(planCandidates({ results: [] }, NOW).error, /no generatedAt/);
});

test('planCandidates keeps only card-specific STUCK rows', () => {
  const report = {
    generatedAt: iso(NOW - 3600e3),
    results: [
      row({ id: 'BRO-1' }),
      row({ id: 'BRO-2', state: 'In Progress', cmd: 'node --test scripts/lib/two.test.mjs' }),
      row({ id: 'BRO-3', state: 'Todo', cmd: 'node --test scripts/lib/three.test.mjs' }),
      row({ id: 'BRO-4', channels: ['pr-evidence'], cmd: 'node --test scripts/lib/four.test.mjs' }),
      row({ id: 'BRO-5', cmd: 'node scripts/validate-data.js' }),
      row({ id: 'BRO-6', cmd: 'node --test scripts/lib/shared.test.mjs' }),
      row({ id: 'BRO-7', verdict: 'VERIFIED', cmd: 'node --test scripts/lib/shared.test.mjs' }),
      row({ id: 'BRO-8', verdict: 'FAILED', cmd: 'node --test scripts/lib/eight.test.mjs' }),
    ],
  };
  const { candidates, skipped } = planCandidates(report, NOW);
  assert.deepEqual(candidates.map((c) => c.id), ['BRO-1', 'BRO-2']);
  assert.equal(candidates[0].testPath, 'scripts/lib/one.test.mjs');
  assert.deepEqual(skipped, {
    'state-Todo': 1,
    'no-verify-command': 1,
    'command-not-a-single-test-file': 1,
    'command-shared-with-another-card': 1,
  });
});

test('futureRecheckAfter only fires for dates still ahead', () => {
  assert.equal(futureRecheckAfter(['RECHECK-AFTER: 2026-10-09'], NOW), '2026-10-09');
  assert.equal(futureRecheckAfter(['RECHECK-AFTER: 2026-10-01'], NOW), null);
  assert.equal(futureRecheckAfter([null, 'nothing here'], NOW), null);
});

const candidate = { id: 'BRO-1', state: 'In Review', cmd: 'node --test scripts/lib/one.test.mjs', testPath: 'scripts/lib/one.test.mjs' };
const issue = (over) => ({
  state: { name: 'In Review', type: 'started' },
  createdAt: iso(NOW - 10 * DAY),
  updatedAt: iso(NOW - 3 * DAY),
  description: 'problem text',
  comments: [{ body: 'Session report (in-review)', createdAt: iso(NOW - 3 * DAY) }],
  ...over,
});
const commits = [{ sha: 'aaa111', message: 'unrelated change' }, { sha: 'bbb222bbb222ccc', message: 'BRO-1: the fix' }];

test('decideClosure closes an idle card whose own commit touched its test', () => {
  assert.deepEqual(decideClosure({ candidate, issue: issue(), commits, nowMs: NOW }), { close: true, sha: 'bbb222bbb222ccc' });
});

test('decideClosure refuses every unsafe case', () => {
  const r = (over, c = commits, cand = candidate) => decideClosure({ candidate: cand, issue: over === null ? null : issue(over), commits: c, nowMs: NOW }).reason;
  assert.equal(r(null), 'issue-not-found');
  assert.equal(r({ state: { name: 'Done', type: 'completed' } }), 'state-changed-since-audit');
  assert.equal(r({ updatedAt: iso(NOW - 2 * 3600e3) }), 'recent-activity');
  assert.equal(r({ comments: [{ body: 'x', createdAt: iso(NOW - 3600e3) }] }), 'recent-activity');
  assert.equal(r({ description: 'RECHECK-AFTER: 2026-10-09' }), 'recheck-after-pending');
  assert.equal(r({ comments: [{ body: `${CLOSER_MARKER}.`, createdAt: iso(NOW - 3 * DAY) }] }), 'closer-already-tried');
  assert.equal(r({}, [{ sha: 'a', message: 'BRO-10: other card' }]), 'no-commit-naming-card-touched-test');
  assert.equal(r({}, []), 'no-commit-naming-card-touched-test');
  // In Progress needs 72h of quiet, not 24h.
  const ip = { ...candidate, state: 'In Progress' };
  assert.equal(r({ state: { name: 'In Progress' }, updatedAt: iso(NOW - 2 * DAY), comments: [] }, commits, ip), 'recent-activity');
  assert.equal(decideClosure({ candidate: ip, issue: issue({ state: { name: 'In Progress' }, updatedAt: iso(NOW - 4 * DAY), comments: [] }), commits, nowMs: NOW }).close, true);
});

test('buildClosureComment carries the marker and no gate-evidence keywords', () => {
  const body = buildClosureComment({ candidate, sha: 'bbb222bbb222ccc', auditGeneratedAt: '2026-10-02T13:20:17Z' });
  assert.ok(body.startsWith(CLOSER_MARKER));
  assert.match(body, /bbb222bbb222/);
  assert.doesNotMatch(body, /VERIFY:|PR-EVIDENCE:|^Dispatched/m);
});
