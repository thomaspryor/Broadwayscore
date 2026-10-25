// BRO-5260: an ensemble not_a_review rejection made on a stub/excerpt must be
// re-evaluated once a refetch upgrades the row to a complete full text. The
// daily sweep (clear-stale-automated-text-verdicts.js) is the writer-agnostic
// path; this pins the predicate and the workflow wiring against the real code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  staleAutomatedTextVerdicts,
  neutralizeStaleAutomatedTextVerdict,
} = require('../../scripts/lib/stale-automated-text-verdict.js');
const { processRecord } = require('../../scripts/clear-stale-automated-text-verdicts.js');

const BODY = 'A sharp, funny production with a standout lead performance. '.repeat(50);

function rejectedStub(over = {}) {
  return {
    showId: 'x-2024', outletId: 'talkinbroadway', criticName: 'Howard Miller',
    url: 'https://www.talkinbroadway.com/page/x.html',
    fullText: BODY, contentTier: 'complete',
    rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'not_a_review',
    rejectionReasoning: 'teaser fragment', rejectedAt: '2026-02-15T16:13:32.271Z',
    textFetchedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

test('refetch that upgrades to complete text after an ensemble rejection is re-queued', () => {
  const d = rejectedStub();
  assert.deepEqual(staleAutomatedTextVerdicts(d), ['rejection']);
  neutralizeStaleAutomatedTextVerdict(d, '2026-10-21T00:00:00.000Z');
  assert.equal(d.rejectionReason ?? null, null);
  assert.equal(d.rejectedBy ?? null, null);
  assert.equal(d.priorAutomatedTextVerdicts.at(-1).rejectionReason, 'not_a_review');
});

test('the sweep raises needsRescore for a scoreable stale rejection', () => {
  const d = rejectedStub();
  const show = { id: 'x-2024', title: 'X', openingDate: '2024-03-01', status: 'closed' };
  const row = processRecord({ data: d, show, path: '/tmp/x-2024/talkinbroadway--howard-miller.json', rel: 'x-2024/talkinbroadway--howard-miller.json', kinds: ['rejection'] }, new Date('2026-10-21T00:00:00Z'));
  assert.equal(row.changed, true);
  assert.equal(d.needsRescore, true);
  assert.equal(d.rejectionReason ?? null, null);
});

test('a rejection made after the fetch, or on a still-short body, stays', () => {
  assert.deepEqual(staleAutomatedTextVerdicts(rejectedStub({ rejectedAt: '2026-10-02T00:00:00Z' })), []);
  assert.deepEqual(staleAutomatedTextVerdicts(rejectedStub({ fullText: 'short teaser' })), []);
  assert.deepEqual(staleAutomatedTextVerdicts(rejectedStub({ contentTier: 'excerpt' })), []);
});

test('a human verdict is never re-queued', () => {
  assert.deepEqual(staleAutomatedTextVerdicts(rejectedStub({ rejectedBy: 'manual-triage-bro-71' })), []);
  assert.deepEqual(staleAutomatedTextVerdicts(rejectedStub({ isNotReview: true })), []);
});

test('the sweep runs daily from the ensemble workflow', () => {
  const yml = fs.readFileSync(new URL('../../.github/workflows/llm-ensemble-score.yml', import.meta.url), 'utf8');
  assert.match(yml, /node scripts\/clear-stale-automated-text-verdicts\.js --apply/);
});
