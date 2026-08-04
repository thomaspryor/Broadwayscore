// Repeat workflow failures must be promoted from a passive digest body section
// into first-class check results so they drive the digest subject line and the
// escalation machinery — the gap that let main test.yml fail 11/19 push runs
// over 2026-06-13→15 without ever bumping the digest off "All clear".
// Notion 381637c5-416f-815b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { repeatFailureResults, isRepeatFailureSelfHealed, feedbackBacklogResults, obClosingBacklogResults, neverRunWorkflowResults, cardVerifiabilityBacklogResults, progressWatchResults, getDigestSubject, getPlaybookEntry } = require('../../scripts/health-check.js');

test('repeatFailureResults: skipped summary yields no synthetic checks', () => {
  assert.deepEqual(repeatFailureResults({ skipped: true, repeatFailures: [{ name: 'x.yml', count: 9 }] }), []);
  assert.deepEqual(repeatFailureResults(null), []);
  assert.deepEqual(repeatFailureResults(undefined), []);
});

test('repeatFailureResults: clean window yields no synthetic checks', () => {
  assert.deepEqual(repeatFailureResults({ skipped: false, repeatFailures: [] }), []);
});

test('repeatFailureResults: count>=3 is error, exactly 2 is warn', () => {
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [
      { name: 'update-lottery-rush.yml', count: 4, latestUrl: 'https://x/4' },
      { name: 'weekly-grosses.yml', count: 2, latestUrl: 'https://x/2' },
    ],
  });
  assert.equal(results.length, 2);
  const lottery = results.find(r => r.name === 'Workflow repeat-failure: update-lottery-rush.yml');
  const grosses = results.find(r => r.name === 'Workflow repeat-failure: weekly-grosses.yml');
  assert.equal(lottery.status, 'error');
  assert.equal(grosses.status, 'warn');
  assert.match(lottery.message, /failed 4 times/);
});

test('repeatFailureResults: selfHealed downgrades error→warn and notes self-heal', () => {
  // The Aug 1 Test Suite streak ended 05:10 UTC but the digest fired a
  // "likely broken" Fix-this card ~6.5h later — a wasted tap on an
  // already-resolved condition.
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [
      { name: 'test.yml', count: 10, latestUrl: 'https://x/10', selfHealed: true },
      { name: 'weekly-grosses.yml', count: 2, latestUrl: 'https://x/2', selfHealed: true },
    ],
  });
  const testSuite = results.find(r => r.name === 'Workflow repeat-failure: test.yml');
  assert.equal(testSuite.status, 'warn');
  assert.match(testSuite.message, /failed 10 times/);
  assert.match(testSuite.message, /likely self-healed/);
  const grosses = results.find(r => r.name === 'Workflow repeat-failure: weekly-grosses.yml');
  assert.equal(grosses.status, 'warn');
  assert.match(grosses.message, /likely self-healed/);
});

test('repeatFailureResults: without selfHealed the streak still escalates as before', () => {
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [{ name: 'test.yml', count: 10, latestUrl: 'https://x/10', selfHealed: false }],
  });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].message, /likely broken, not transient/);
});

test('isRepeatFailureSelfHealed: requires 2+ consecutive trailing greens, not just a green latest run', () => {
  // Streak genuinely over: greens since the last failure.
  assert.equal(isRepeatFailureSelfHealed(['success', 'success', 'failure', 'failure']), true);
  assert.equal(isRepeatFailureSelfHealed(['success', 'success', 'success', 'failure']), true);
  // Flapping workflow (the 2026-06-13 blindness: 11/19 failures but latest
  // run green most mornings) must NOT count as self-healed.
  assert.equal(isRepeatFailureSelfHealed(['success', 'failure', 'success', 'failure']), false);
  // Latest run red → obviously not healed.
  assert.equal(isRepeatFailureSelfHealed(['failure', 'success', 'success']), false);
  // Degenerate inputs.
  assert.equal(isRepeatFailureSelfHealed(['success']), false);
  assert.equal(isRepeatFailureSelfHealed([]), false);
  assert.equal(isRepeatFailureSelfHealed(null), false);
});

test('playbook routes repeat-failure checks to fix-now (actionable, not low)', () => {
  const entry = getPlaybookEntry('Workflow repeat-failure: update-lottery-rush.yml');
  assert.ok(entry, 'expected a playbook entry to match');
  assert.equal(entry.urgency, 'fix-now');
});

test('getDigestSubject: a promoted repeat-failure error names the workflow (not "All clear")', () => {
  const results = [
    { name: 'Freshness: reviews.json', status: 'pass', message: 'ok' },
    ...repeatFailureResults({
      skipped: false,
      repeatFailures: [{ name: 'update-lottery-rush.yml', count: 5, latestUrl: 'https://x/5' }],
    }),
  ];
  // consecutiveErrorDays >= 2 → ACTION NEEDED branch, which names the first error.
  const subject = getDigestSubject(results, { consecutiveErrorDays: 2 }, {});
  assert.match(subject, /ACTION NEEDED/);
  assert.match(subject, /Workflow repeat-failure: update-lottery-rush\.yml/);
  assert.doesNotMatch(subject, /All clear/);
});

test('getDigestSubject: first-day single repeat-failure error still flags attention', () => {
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [{ name: 'weekly-grosses.yml', count: 3, latestUrl: 'https://x/3' }],
  });
  const subject = getDigestSubject(results, { consecutiveErrorDays: 1 }, {});
  assert.match(subject, /1 error need attention/);
  assert.doesNotMatch(subject, /All clear/);
});

test('getDigestSubject: clean window stays green', () => {
  const results = [
    { name: 'Freshness: reviews.json', status: 'pass', message: 'ok' },
    ...repeatFailureResults({ skipped: false, repeatFailures: [] }),
  ];
  const subject = getDigestSubject(results, { consecutiveErrorDays: 0 }, {});
  assert.match(subject, /All clear/);
});

// --- feedbackBacklogResults (needs-manual-review backlog digest check) ---

test('feedbackBacklogResults: empty backlog and skipped summary yield no results', () => {
  assert.deepEqual(feedbackBacklogResults({ skipped: false, issues: [] }), []);
  assert.deepEqual(feedbackBacklogResults({ skipped: true, issues: [] }), []);
  assert.deepEqual(feedbackBacklogResults(null), []);
});

test('feedbackBacklogResults: open backlog warns with count, oldest age, newest title', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const results = feedbackBacklogResults({
    skipped: false,
    issues: [
      { number: 393, title: 'Bug Diagnosis: MISTERMAN FRC score', createdAt: '2026-07-03T17:00:41Z' },
      { number: 279, title: 'Bug Diagnosis: fluctuating scores', createdAt: '2026-04-24T09:34:49Z' },
    ],
  }, now);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /2 open user-feedback issue\(s\)/);
  assert.match(results[0].message, /oldest 78d/);
  assert.match(results[0].message, /#393/);
});

// --- obClosingBacklogResults (weekly OB closing-detector digest check) ---

test('obClosingBacklogResults: empty or absent report yields nothing', () => {
  assert.deepEqual(obClosingBacklogResults(null), []);
  assert.deepEqual(obClosingBacklogResults({ reviewTextSweep: { candidates: [] }, todaytixStaleness: { candidates: [] } }), []);
});

test('obClosingBacklogResults: candidates warn with count and first show', () => {
  const results = obClosingBacklogResults({
    reviewTextSweep: { candidates: [{ showId: 'clara-2026', proposedClosingDate: '2026-05-10', confidence: 'medium' }] },
    todaytixStaleness: { candidates: [] },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /1 open Off-Broadway show/);
  assert.match(results[0].message, /clara-2026 → 2026-05-10 \[medium\]/);
});

// --- neverRunWorkflowResults (task #737: workflows with zero lifetime runs) ---

test('neverRunWorkflowResults: empty or absent report yields nothing', () => {
  assert.deepEqual(neverRunWorkflowResults(null), []);
  assert.deepEqual(neverRunWorkflowResults({ offenders: [] }), []);
});

test('neverRunWorkflowResults: offenders warn with count and file list', () => {
  const results = neverRunWorkflowResults({
    generatedAt: '2026-08-01T00:00:00.000Z',
    minAgeDays: 30,
    totalChecked: 217,
    offenders: ['ingest-urls.yml', 'btc-results-preview.yml'],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /2 workflow\(s\)/);
  assert.match(results[0].message, /ingest-urls\.yml, btc-results-preview\.yml/);
});

// --- cardVerifiabilityBacklogResults (task #646: undispatchable backlog cards) ---

test('cardVerifiabilityBacklogResults: empty or absent report yields nothing', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults(null), []);
  assert.deepEqual(cardVerifiabilityBacklogResults({ total: 40, refused: [] }), []);
});

test('cardVerifiabilityBacklogResults: refused cards warn with count and first card', () => {
  const results = cardVerifiabilityBacklogResults({
    total: 42,
    refusedCount: 2,
    refused: [
      { id: 'abc', name: 'Fix the widget', priority: 'P1 Next', reason: 'names no runnable command (prose only)' },
      { id: 'def', name: 'Another card', priority: 'P2 Later', reason: 'no acceptance-criteria section or VERIFY line' },
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /2 of 42 pending\/in-progress card/);
  assert.match(results[0].message, /\[P1 Next\] Fix the widget/);
  assert.match(results[0].hint, /enrich-card-acceptance\.js/);
});

// --- progressWatchResults (task #597: liveness monitor for pipeline counters) ---

test('progressWatchResults: no report, or a report with no surfaces, yields nothing', () => {
  assert.deepEqual(progressWatchResults(null), []);
  assert.deepEqual(progressWatchResults(undefined), []);
  assert.deepEqual(progressWatchResults({ surfaces: {} }), []);
});

test('progressWatchResults: no stalled surfaces yields nothing', () => {
  const report = { surfaces: { needsRescoreUnblocked: { label: 'needsRescore queue (unblocked)', value: 90, stalled: false, cycles: 3 } } };
  assert.deepEqual(progressWatchResults(report), []);
});

test('progressWatchResults: a stalled surface warns with value, cycles, and hint', () => {
  const report = {
    surfaces: {
      needsRescoreUnblocked: {
        label: 'needsRescore queue (unblocked)',
        value: 141,
        stalled: true,
        cycles: 3,
        reason: 'unchanged for 3 consecutive cycles (value: 141)',
        hint: 'node scripts/audit-stuck-rescore-flags.js --json for a byReason breakdown',
      },
    },
  };
  const results = progressWatchResults(report);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.equal(results[0].name, 'Progress watch: needsRescore queue (unblocked) stalled');
  assert.match(results[0].message, /is at 141 and hasn't moved in 3 consecutive check/);
  assert.match(results[0].hint, /audit-stuck-rescore-flags\.js/);
});

test('progressWatchResults: includes lastSummary context in a stalled alert message when present (task #761)', () => {
  const report = {
    surfaces: {
      needsRescoreUnblocked: {
        label: 'needsRescore queue (unblocked)',
        value: 141,
        stalled: true,
        cycles: 3,
        reason: 'unchanged for 3 consecutive cycles (value: 141)',
        hint: 'node scripts/audit-stuck-rescore-flags.js --json for a byReason breakdown',
      },
    },
    lastSummary: {
      needsRescoreUnblocked: 141,
      needsRescoreRaw: 200,
      needsRescoreNotScoreable: 40,
      needsRescoreBlocked: 19,
    },
  };
  const results = progressWatchResults(report);
  assert.equal(results.length, 1);
  assert.match(results[0].message, /is at 141 and hasn't moved in 3 consecutive check\(s\)\. Context: /);
  assert.match(results[0].message, /"needsRescoreRaw":200/);
  assert.match(results[0].message, /"needsRescoreNotScoreable":40/);
  assert.match(results[0].message, /"needsRescoreBlocked":19/);
});

test('progressWatchResults: omits context when lastSummary is absent', () => {
  const report = {
    surfaces: {
      needsRescoreUnblocked: {
        label: 'needsRescore queue (unblocked)',
        value: 141,
        stalled: true,
        cycles: 3,
        hint: 'node scripts/audit-stuck-rescore-flags.js --json for a byReason breakdown',
      },
    },
  };
  const results = progressWatchResults(report);
  assert.equal(results.length, 1);
  assert.equal(results[0].message, "needsRescore queue (unblocked) is at 141 and hasn't moved in 3 consecutive check(s).");
  assert.doesNotMatch(results[0].message, /Context:/);
});

test('progressWatchResults: an unserializable lastSummary (circular ref) omits context but still surfaces the alert (task #761 hardening)', () => {
  const circular = { needsRescoreUnblocked: 141 };
  circular.self = circular;
  const report = {
    surfaces: {
      needsRescoreUnblocked: {
        label: 'needsRescore queue (unblocked)',
        value: 141,
        stalled: true,
        cycles: 3,
        hint: 'node scripts/audit-stuck-rescore-flags.js --json for a byReason breakdown',
      },
    },
    lastSummary: circular,
  };
  const results = progressWatchResults(report);
  assert.equal(results.length, 1);
  assert.equal(results[0].message, "needsRescore queue (unblocked) is at 141 and hasn't moved in 3 consecutive check(s).");
  assert.doesNotMatch(results[0].message, /Context:/);
});

test('progressWatchResults: an oversized lastSummary is truncated in the alert message', () => {
  const report = {
    surfaces: {
      needsRescoreUnblocked: {
        label: 'needsRescore queue (unblocked)',
        value: 141,
        stalled: true,
        cycles: 3,
        hint: 'node scripts/audit-stuck-rescore-flags.js --json for a byReason breakdown',
      },
    },
    lastSummary: { hugeField: 'x'.repeat(1000) },
  };
  const results = progressWatchResults(report);
  assert.equal(results.length, 1);
  assert.match(results[0].message, /Context: .{500}…$/);
});

// ── cards the drain cannot finish unattended (task #1004) ──────────────────
// backlog-drain writes humanGatedSkips into its metric; without a digest row
// that field is write-only and a MISCLASSIFIED card is skipped silently every
// tick forever (the #689/#690 write-only class).

test('cardVerifiabilityBacklogResults surfaces human-gated drain skips as their own row', () => {
  const rows = cardVerifiabilityBacklogResults(
    { total: 200, refused: [{ name: 'X', priority: 'P2' }] },
    { humanGatedSkips: [{ id: '61', codes: ['VISUAL_QA_GATE'] }, { id: '63', codes: ['VISUAL_QA_GATE'] }] },
  );
  assert.equal(rows.length, 2);
  const gated = rows.find(r => r.name === 'Data: cards the drain cannot finish unattended');
  assert.ok(gated, `expected the gated row, got ${rows.map(r => r.name).join(' | ')}`);
  assert.match(gated.message, /#61, #63/);
  assert.match(gated.message, /VISUAL_QA_GATE/);
  assert.equal(gated.status, 'warn');
});

test('cardVerifiabilityBacklogResults stays back-compatible when the drain metric is absent', () => {
  const rows = cardVerifiabilityBacklogResults({ total: 200, refused: [{ name: 'X', priority: 'P2' }] }, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Data: undispatchable backlog cards');
});

test('cardVerifiabilityBacklogResults emits the gated row even when the verifiability report is missing', () => {
  const rows = cardVerifiabilityBacklogResults(null, { humanGatedSkips: [{ id: '61', codes: ['VISUAL_QA_GATE'] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Data: cards the drain cannot finish unattended');
});

test('cardVerifiabilityBacklogResults is silent when both buckets are empty', () => {
  assert.equal(cardVerifiabilityBacklogResults(null, null).length, 0);
  assert.equal(cardVerifiabilityBacklogResults({ total: 5, refused: [] }, { humanGatedSkips: [] }).length, 0);
});
