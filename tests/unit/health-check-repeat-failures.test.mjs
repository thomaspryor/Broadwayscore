// Repeat workflow failures must be promoted from a passive digest body section
// into first-class check results so they drive the digest subject line and the
// escalation machinery — the gap that let main test.yml fail 11/19 push runs
// over 2026-06-13→15 without ever bumping the digest off "All clear".
// Notion 381637c5-416f-815b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { hasNoAutomatedPath } = require('../../scripts/lib/t1-silent-gap.js');
const { silentGapBacklogResults, bwwRoundupMissBacklogResults, repeatFailureResults, isRepeatFailureSelfHealed, isGateWorkflowBroken, GATE_WORKFLOWS, summarizeRepeatFailures, effectiveUrgencyLevel, feedbackBacklogResults, obClosingBacklogResults, neverRunWorkflowResults, cardVerifiabilityBacklogResults, progressWatchResults, getDigestSubject, getPlaybookEntry } = require('../../scripts/health-check.js');

test('repeatFailureResults: skipped summary yields no synthetic checks', () => {
  assert.deepEqual(repeatFailureResults({ skipped: true, repeatFailures: [{ name: 'x.yml', count: 9 }] }), []);
  assert.deepEqual(repeatFailureResults(null), []);
  assert.deepEqual(repeatFailureResults(undefined), []);
});

test('repeatFailureResults: clean window yields no synthetic checks', () => {
  assert.deepEqual(repeatFailureResults({ skipped: false, repeatFailures: [] }), []);
});

test('BRO-3178: synthetic check names and messages identify the failed job and step', () => {
  const repeatFailures = summarizeRepeatFailures([
    { name: 'Deploy to Vercel', conclusion: 'failure', failureSteps: [{ job: 'deploy', step: 'Setup Playwright' }] },
    { name: 'Deploy to Vercel', conclusion: 'failure', failureSteps: [{ job: 'deploy', step: 'Setup Playwright' }] },
    { name: 'Deploy to Vercel', conclusion: 'failure', failureSteps: [{ job: 'deploy', step: 'Deploy to Production' }] },
  ]);
  const results = repeatFailureResults({ repeatFailures });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Workflow repeat-failure: Deploy to Vercel / deploy / Setup Playwright');
  assert.match(results[0].message, /Setup Playwright failed 2 times/);
  assert.doesNotMatch(results[0].message, /Deploy to Production/);
});

test('BRO-3178: unavailable step details are explicit in the alert', () => {
  const results = repeatFailureResults({ repeatFailures: [{ name: 'Deploy', count: 2, detailsUnavailable: true }] });
  assert.match(results[0].message, /failed-step details unavailable/);
});

test('BRO-3178: getWorkflowRunSummary fetches step details before grouping', async t => {
  const healthPath = require.resolve('../../scripts/health-check.js');
  const groupingPath = require.resolve('../../scripts/lib/workflow-repeat-failures.js');
  const savedModules = [require.cache[healthPath], require.cache[groupingPath]];
  const savedToken = process.env.GH_TOKEN;
  t.after(() => {
    [require.cache[healthPath], require.cache[groupingPath]] = savedModules;
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
  });
  process.env.GH_TOKEN = 'test-only';
  const cache = require('../../scripts/lib/gh-api-cache.js');
  t.mock.method(cache, 'cachedFetch', async (_key, fn) => fn());
  t.mock.method(cache, 'hasLowHeadroom', () => false);
  const urls = [];
  t.mock.method(require('../../scripts/lib/gh-api-client.js'), 'fetchGitHubJSON', async url => {
    urls.push(url);
    if (url.includes('/actions/runs?')) return { workflow_runs: [1, 2, 3].map(id => ({
      id, name: 'Deploy to Vercel', status: 'completed', conclusion: 'failure',
      created_at: `2026-10-29T00:0${id}:00Z`, html_url: `https://example.com/${id}`,
    })) };
    const step = url.includes('/runs/3/') ? 'Setup Playwright' : 'Deploy to Production';
    return { total_count: 1, jobs: [{ name: 'deploy', conclusion: 'failure', steps: [{ name: step, conclusion: 'failure' }] }] };
  });
  delete require.cache[healthPath];
  delete require.cache[groupingPath];
  const summary = await require(healthPath).getWorkflowRunSummary();
  assert.equal(summary.skipped, false);
  assert.equal(summary.failed, 3);
  assert.equal(summary.repeatFailures.length, 1);
  assert.equal(summary.repeatFailures[0].step, 'Deploy to Production');
  assert.equal(summary.repeatFailures[0].count, 2);
  assert.equal(urls.length, 4, 'one run-list request plus one jobs request per failed run');
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

// BRO-2742: the static playbook's fix-now urgency ignored r.selfHealed, so an
// already-resolved repeat-failure streak still filed an alarming Linear card.
test('effectiveUrgencyLevel: selfHealed result downgrades to low regardless of playbook urgency', () => {
  assert.equal(effectiveUrgencyLevel('fix-now', { selfHealed: true }), 'low');
  assert.equal(effectiveUrgencyLevel('this-week', { selfHealed: true }), 'low');
});

test('effectiveUrgencyLevel: non-selfHealed or unrelated results pass urgency through unchanged', () => {
  assert.equal(effectiveUrgencyLevel('fix-now', { selfHealed: false }), 'fix-now');
  assert.equal(effectiveUrgencyLevel('fix-now', {}), 'fix-now');
  assert.equal(effectiveUrgencyLevel('low', { selfHealed: true }), 'low');
});

test('effectiveUrgencyLevel: tolerates a null/undefined result', () => {
  assert.equal(effectiveUrgencyLevel('fix-now', null), 'fix-now');
  assert.equal(effectiveUrgencyLevel('fix-now', undefined), 'fix-now');
});

// BRO-2742 follow-up: getDigestSubject/updateErrorFingerprint/the status
// banner each reimplemented the same "is this actionable" filter inline from
// the static playbook alone — none of them knew about selfHealed either, so
// even after downgrading the card-filing urgency a selfHealed repeat-failure
// could still drive "BSC Daily: N warnings need attention" in the subject
// while the digest body said "no action needed". They now share
// isActionableResult(), which is selfHealed-aware.
// Codex adversarial review (ship-check) caught a real regression here: the
// three inline predicates this replaced treated "no playbook entry at all"
// as actionable (`!entry || ...`), but an early isActionableResult() draft
// defaulted a missing entry's urgency to 'low', silently dropping any check
// with no AUTO_FIX_PLAYBOOK match from the subject/fingerprint/banner.
test('getDigestSubject: a warning with no playbook entry still counts (no silent drop)', () => {
  const results = [{ name: 'Some brand-new check with no playbook match', status: 'warn', message: 'uh oh' }];
  const subject = getDigestSubject(results, { consecutiveErrorDays: 0 }, {});
  assert.match(subject, /1 warning/);
  assert.doesNotMatch(subject, /All clear/);
});

test('getDigestSubject: a selfHealed repeat-failure warning does not trigger "warnings need attention"', () => {
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [{ name: 'opening-night-broadcast.yml', count: 4, latestUrl: 'https://x/4', selfHealed: true }],
  });
  assert.equal(results[0].status, 'warn');
  const subject = getDigestSubject(results, { consecutiveErrorDays: 0 }, {});
  assert.match(subject, /All clear/);
  assert.doesNotMatch(subject, /warning/);
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

test('feedbackBacklogResults: empty backlog is a pass row; skipped summary yields no results', () => {
  assert.deepEqual(feedbackBacklogResults({ skipped: false, issues: [] }).map((r) => [r.name, r.status]), [['Feedback: needs-manual-review backlog', 'pass']]);
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

test('obClosingBacklogResults: absent report yields nothing; empty report yields pass rows (BRO-3833)', () => {
  assert.deepEqual(obClosingBacklogResults(null), []);
  // No unmonitoredOpenShows field (older report): only the candidates row was computed.
  assert.deepEqual(
    obClosingBacklogResults({ reviewTextSweep: { candidates: [] }, todaytixStaleness: { candidates: [] } }).map((r) => [r.name, r.status]),
    [['Data: OB closing candidates awaiting review', 'pass']],
  );
});

test('obClosingBacklogResults: single candidate warns with count and show', () => {
  const results = obClosingBacklogResults({
    reviewTextSweep: { candidates: [{ showId: 'clara-2026', proposedClosingDate: '2026-05-10', confidence: 'medium' }] },
    todaytixStaleness: { candidates: [] },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /1 open Off-Broadway show/);
  assert.match(results[0].message, /clara-2026 → 2026-05-10 \[medium\]/);
});

test('obClosingBacklogResults: names the OLDEST todaytixStaleness candidate, not array position 0', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const results = obClosingBacklogResults({
    reviewTextSweep: { candidates: [{ showId: 'newer-review-candidate-2026', proposedClosingDate: '2026-08-30', confidence: 'medium' }] },
    todaytixStaleness: { candidates: [{ showId: 'are-you-now-or-have-you-ever-been-off-broadway-2026', consecutiveMissingChecks: 5, firstMissingDate: '2026-08-03' }] },
  }, now);
  assert.equal(results.length, 1);
  // 2026-08-03 -> 2026-09-05 is 33 days, past the 21-day error threshold, and
  // older than the reviewTextSweep candidate (which carries no age signal at all).
  assert.equal(results[0].status, 'error');
  assert.match(results[0].message, /2 open Off-Broadway show/);
  assert.match(results[0].message, /are-you-now-or-have-you-ever-been-off-broadway-2026 \(missing 33d\)/);
});

test('obClosingBacklogResults: recent todaytixStaleness candidate stays warn', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const results = obClosingBacklogResults({
    reviewTextSweep: { candidates: [] },
    todaytixStaleness: { candidates: [{ showId: 'freshly-missing-2026', consecutiveMissingChecks: 1, firstMissingDate: '2026-09-01' }] },
  }, now);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /freshly-missing-2026 \(missing 4d\)/);
});

// BRO-4699: the 2026-10-05 detector run was cancelled, so the 09-28 snapshot
// kept naming two shows already closed in shows.json (one counted twice).
const STALE_OB_REPORT = {
  reviewTextSweep: { candidates: [{ showId: 'my-joy-is-heavy-off-broadway-2025', proposedClosingDate: '2026-04-05', confidence: 'high' }] },
  todaytixStaleness: { candidates: [
    { showId: 'pied-a-terre-off-broadway-2026', consecutiveMissingChecks: 2, firstMissingDate: '2026-09-21' },
    { showId: 'my-joy-is-heavy-off-broadway-2025', consecutiveMissingChecks: 2, firstMissingDate: '2026-09-21' },
  ] },
  unmonitoredOpenShows: [{ showId: 'closed-blind-2026', daysOpen: 40 }],
};

test('obClosingBacklogResults: candidates already closed in shows.json are dropped', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  const shows = [
    { id: 'my-joy-is-heavy-off-broadway-2025', status: 'closed' },
    { id: 'pied-a-terre-off-broadway-2026', status: 'closed' },
    { id: 'closed-blind-2026', status: 'closed' },
  ];
  // Nothing left to flag: BRO-3833 pass rows (same names) instead of [].
  const rows = obClosingBacklogResults(STALE_OB_REPORT, now, shows);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [
    ['Data: OB shows no closing signal can detect', 'pass'],
    ['Data: OB closing candidates awaiting review', 'pass'],
  ]);
});

test('obClosingBacklogResults: a show in both signals counts once; open shows still reported', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  const shows = [
    { id: 'my-joy-is-heavy-off-broadway-2025', status: 'open' },
    { id: 'pied-a-terre-off-broadway-2026', status: 'open' },
    { id: 'closed-blind-2026', status: 'open' },
  ];
  const results = obClosingBacklogResults(STALE_OB_REPORT, now, shows);
  const row = results.find((r) => r.name === 'Data: OB closing candidates awaiting review');
  assert.match(row.message, /^2 open Off-Broadway show\(s\)/);
  assert.ok(results.find((r) => r.name === 'Data: OB shows no closing signal can detect'));
  // Without shows, the snapshot is reported as-is (old behaviour).
  assert.equal(obClosingBacklogResults(STALE_OB_REPORT, now).length, 2);
  // An empty list or an id missing from shows.json never hides a row.
  assert.equal(obClosingBacklogResults(STALE_OB_REPORT, now, []).length, 2);
  const partial = obClosingBacklogResults(STALE_OB_REPORT, now, [{ id: 'my-joy-is-heavy-off-broadway-2025', status: 'closed' }]);
  assert.match(partial.find((r) => r.name === 'Data: OB closing candidates awaiting review').message, /^1 open .*pied-a-terre/);
});

// --- neverRunWorkflowResults (task #737: workflows with zero lifetime runs) ---

test('neverRunWorkflowResults: absent report yields nothing; empty offenders is a pass row', () => {
  assert.deepEqual(neverRunWorkflowResults(null), []);
  assert.deepEqual(neverRunWorkflowResults({ offenders: [], totalChecked: 5, unknownCount: 0 }).map((r) => [r.name, r.status]), [['Workflow coverage: never-run', 'pass']]);
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

// --- cardVerifiabilityBacklogResults (task #646): the Linear-report rows are
// covered in tests/unit/health-check-card-verifiability-vacuous.test.mjs; the
// Notion-report row was retired (BRO-4717).

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
    { humanGatedSkips: [{ id: '61', codes: ['VISUAL_QA_GATE'] }, { id: '63', codes: ['VISUAL_QA_GATE'] }] },
    null,
  );
  assert.equal(rows.length, 1);
  const gated = rows.find(r => r.name === 'Data: cards the drain cannot finish unattended');
  assert.ok(gated, `expected the gated row, got ${rows.map(r => r.name).join(' | ')}`);
  assert.match(gated.message, /#61, #63/);
  assert.match(gated.message, /VISUAL_QA_GATE/);
  assert.equal(gated.status, 'warn');
});

test('cardVerifiabilityBacklogResults combines the gated row with Linear rows', () => {
  const rows = cardVerifiabilityBacklogResults(
    { humanGatedSkips: [{ id: '61', codes: ['VISUAL_QA_GATE'] }] },
    { total: 3, refused: [{ id: 'BRO-1', name: 'X' }], vacuousChecks: [], generatedAt: new Date().toISOString() },
  );
  assert.deepEqual(rows.filter(r => r.status !== 'pass').map(r => r.name).sort(), ['Data: cards the drain cannot finish unattended', 'Data: undispatchable Linear backlog cards']);
});

test('cardVerifiabilityBacklogResults is silent when both buckets are empty', () => {
  assert.equal(cardVerifiabilityBacklogResults(null, null).length, 0);
  assert.equal(cardVerifiabilityBacklogResults({ humanGatedSkips: [] }, null).length, 0);
});

// BRO-4288: oldest backlog entries must be named even when listed last.
for (const [label, digest, wrap, field] of [
  ['silent gaps', silentGapBacklogResults, items => ({ gaps: items }), 'firstSeen'],
  ['BWW misses', bwwRoundupMissBacklogResults, items => items, 'lastMissTs'],
]) {
  for (const [days, status] of [[20, 'warn'], [21, 'error'], [33, 'error']]) {
    test(`${label}: names oldest and escalates at ${days} days`, () => {
      const now = new Date('2026-09-05T00:00:00Z');
      const olderDate = new Date(now.getTime() - days * 86400000).toISOString();
      const items = [
        { showId: 'newer', [field]: '2026-09-04', tier: 1, outletId: 'nyt', type: 'stub', missCount: 2 },
        { showId: 'oldest', [field]: olderDate, tier: 2, outletId: 'post', type: 'stub', missCount: 3 },
      ];
      const before = structuredClone(items);
      const [row] = digest(wrap(items), now);
      assert.match(row.message, /Oldest: oldest/);
      assert.equal(row.status, status);
      assert.deepEqual(items, before);
    });
  }
  test(`${label}: absent or empty report stays silent`, () => {
    assert.deepEqual(digest(null), []);
    assert.deepEqual(digest(wrap([])), []);
  });
}

const { rankByAge } = require('../../scripts/lib/backlog-digest-age');
test('rankByAge: invalid/missing dates sort last, ties are stable, future dates do not escalate', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const items = [{ date: 'bad' }, {}, { date: '2026-09-06' }, { date: '2026-09-01' }, { date: '2026-09-01' }];
  assert.deepEqual(rankByAge(items, 'date', 21, now), { oldest: items[3], ageDays: 4, status: 'warn' });
  assert.deepEqual(rankByAge(items.slice(0, 2), 'date', 21, now), { oldest: items[0], ageDays: null, status: 'warn' });
  assert.equal(rankByAge(items.slice(2, 3), 'date', 21, now).status, 'warn');
  assert.equal(rankByAge([], 'date'), null);
});

test('silentGapBacklogResults: real audit report shape', async t => {
  const { existsSync, readFileSync } = await import('node:fs');
  const file = new URL('../../data/audit/t1-silent-gaps.json', import.meta.url);
  if (!existsSync(file)) return t.skip('Audit report unavailable');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  // Clock two days after the report: every gap is past the in-flight window.
  const rows = silentGapBacklogResults(report, new Date(Date.parse(report.generatedAt) + 86400000 * 2));
  // BRO-6082: needsManualRecovery gaps are the audit's FYI digest line, not a warn row.
  assert.equal(rows.length, report.gaps.some(g => g.needsManualRecovery !== true && !hasNoAutomatedPath(g)) ? 1 : 0);
  if (rows.length) assert.match(rows[0].message, /Oldest:/);
});

// BRO-6082: deterministic cover for the filter the real-data test above depends on.
test('silentGapBacklogResults: needsManualRecovery gaps never produce a row', () => {
  const now = new Date('2026-10-13T02:00:00Z');
  const manual = { showId: 'm', tier: 1, outletId: 'nyt', type: 'paywalled', firstSeen: '2026-09-01T00:00:00Z', needsManualRecovery: true };
  const auto = { showId: 'a', tier: 1, outletId: 'vulture', type: 'unscored', firstSeen: '2026-09-01T00:00:00Z' };
  assert.deepEqual(silentGapBacklogResults({ gaps: [manual] }, now), []);
  const [row] = silentGapBacklogResults({ gaps: [manual, auto] }, now);
  assert.match(row.message, /^1 discovered review\(s\).*Oldest: a /);
});

// BRO-6632: an abandoned, undispatchable fetch is not a silent gap to page on yet.
test('silentGapBacklogResults: gaps with no automated path left never produce a row before the manual clock', () => {
  const now = new Date('2026-10-13T02:00:00Z');
  const base = { showId: 'p', tier: 1, outletId: 'nyt', firstSeen: '2026-10-10T00:00:00Z', gapSeenAt: '2026-10-11T00:00:00Z' };
  const paywalled = { ...base, type: 'paywalled', recoverable: false };
  const undispatchable = { ...base, type: 'unscored', dispatchable: false };
  const forumTryLeft = { ...base, type: 'stub', recoverable: false, url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?thread=1', forumLinkRecoveryCount: 0 };
  assert.deepEqual(silentGapBacklogResults({ gaps: [paywalled, undispatchable] }, now), []);
  assert.equal(silentGapBacklogResults({ gaps: [{ ...paywalled, recoverable: true }] }, now).length, 1);
  assert.equal(silentGapBacklogResults({ gaps: [{ ...undispatchable, dispatchable: true }] }, now).length, 1);
  assert.equal(hasNoAutomatedPath(forumTryLeft), false);
});

// BRO-5166: a review discovered minutes ago is in flight, not silent.
test('silentGapBacklogResults: files discovered under 24h ago are not counted', () => {
  const now = new Date('2026-10-13T02:00:00Z');
  const fresh = { showId: 'fresh', tier: 1, outletId: 'vulture', type: 'empty-body', firstSeen: '2026-10-13T01:09:00Z', gapSeenAt: '2026-10-13T01:40:00Z' };
  const old = { showId: 'old', tier: 1, outletId: 'daily-mail', type: 'unscored', firstSeen: '2026-09-22T16:40:00Z', gapSeenAt: '2026-10-11T09:39:00Z' };
  const unstamped = { showId: 'unstamped', tier: 2, outletId: 'post', type: 'stub' };
  assert.deepEqual(silentGapBacklogResults({ gaps: [fresh] }, now), []);
  const [row] = silentGapBacklogResults({ gaps: [fresh, old] }, now);
  assert.match(row.message, /^1 discovered review\(s\).*Oldest: old.*; 1 newer still in flight$/);
  // Old file whose gap clock restarted minutes ago (flapping): still counted.
  assert.equal(silentGapBacklogResults({ gaps: [{ ...old, gapSeenAt: '2026-10-13T01:50:00Z' }] }, now).length, 1);
  // Boundary: exactly 24h old counts, one minute younger does not.
  assert.equal(silentGapBacklogResults({ gaps: [{ ...fresh, firstSeen: '2026-10-12T02:00:00Z' }] }, now).length, 1);
  assert.deepEqual(silentGapBacklogResults({ gaps: [{ ...fresh, firstSeen: '2026-10-12T02:01:00Z' }] }, now), []);
  // No stamp at all: fail open, still counted.
  assert.equal(silentGapBacklogResults({ gaps: [unstamped] }, now).length, 1);
});

// BRO-5174: Land's red runs are the gate refusing branches (alerted per
// branch by land-alert.js), not Land breaking. The 2026-10-14 window had 6
// refusals among ~22 landings and still filed "Workflow repeat-failure: Land".
test('isGateWorkflowBroken: interleaved refusals with greens is a working gate', () => {
  assert.ok(GATE_WORKFLOWS.has('Land'));
  // Real Land completed-run conclusions 2026-10-14, newest first.
  const land20261014 = ['failure', 'failure', 'success', 'success', 'success', 'failure', 'success',
    'success', 'success', 'success', 'success', 'success', 'success', 'success', 'success', 'success',
    'failure', 'success', 'failure', 'success', 'success', 'success', 'success', 'failure'];
  assert.equal(isGateWorkflowBroken(land20261014), false);
  assert.equal(isGateWorkflowBroken(['failure', 'failure', 'failure', 'success']), false);
});

test('isGateWorkflowBroken: no green in the window, or 4+ reds at the head, is broken', () => {
  assert.equal(isGateWorkflowBroken(['failure', 'failure']), true);
  assert.equal(isGateWorkflowBroken(['failure', 'cancelled', 'failure']), true);
  assert.equal(isGateWorkflowBroken(['failure', 'failure', 'failure', 'failure', 'success', 'success']), true);
  // Land's queue-park and superseded-push cancels must not reset the streak.
  assert.equal(isGateWorkflowBroken(['cancelled', 'failure', 'failure', 'failure', 'failure', 'success']), true);
  assert.equal(isGateWorkflowBroken(['failure', 'cancelled', 'failure', 'skipped', 'failure', 'failure', 'success']), true);
  // Exactly 3 reds at the head with a green further back is still a working gate.
  assert.equal(isGateWorkflowBroken(['failure', 'cancelled', 'failure', 'failure', 'cancelled', 'success']), false);
  assert.equal(isGateWorkflowBroken([]), true);
  assert.equal(isGateWorkflowBroken(undefined), true);
});

test('summarizeRepeatFailures: Land refusals among greens are dropped; a Land that never lands is kept', () => {
  const run = (name, conclusion, minsAgo) => ({ name, status: 'completed', conclusion,
    created_at: new Date(Date.UTC(2026, 9, 14, 12) - minsAgo * 60000).toISOString(), html_url: `https://x/${name}/${minsAgo}` });
  const refusingLand = [run('Land', 'failure', 1), run('Land', 'success', 2), run('Land', 'failure', 3),
    run('Land', 'success', 4), run('Land', 'failure', 5)];
  const other = [run('Broken Cron', 'failure', 1), run('Broken Cron', 'failure', 2), run('Broken Cron', 'failure', 3)];
  assert.deepEqual(summarizeRepeatFailures([...refusingLand, ...other]).map(r => [r.name, r.count]), [['Broken Cron', 3]]);
  // Non-gate workflows keep the old behaviour even when greens interleave.
  const flappy = refusingLand.map(r => ({ ...r, name: 'Test Suite' }));
  assert.deepEqual(summarizeRepeatFailures(flappy).map(r => r.name), ['Test Suite']);
  // selfHealed annotation survives the extraction (2 trailing greens).
  const healed = [run('Test Suite', 'success', 1), run('Test Suite', 'success', 2),
    run('Test Suite', 'failure', 3), run('Test Suite', 'failure', 4)];
  assert.equal(summarizeRepeatFailures(healed)[0].selfHealed, true);
  assert.equal(summarizeRepeatFailures(flappy)[0].selfHealed, false);
  // A Land that stopped landing anything is still surfaced.
  const deadLand = [run('Land', 'failure', 1), run('Land', 'failure', 2), run('Land', 'failure', 3)];
  const out = summarizeRepeatFailures(deadLand);
  assert.deepEqual(out.map(r => [r.name, r.count]), [['Land', 3]]);
  assert.equal(repeatFailureResults({ skipped: false, repeatFailures: out })[0].name, 'Workflow repeat-failure: Land');
});
