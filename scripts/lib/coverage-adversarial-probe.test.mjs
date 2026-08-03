import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyCandidate,
  classifyNonReviewUrl,
  lookupRecord,
  summarizeShow,
  summarizeRun,
  evaluateAcceptance,
  detectProviderOutage,
  onDiskUnavailable,
} = require('./coverage-adversarial-probe.js');

const SHOW = { id: 'the-car-man-west-end-2026', title: 'The Car Man' };

function guardsFor({ includable, exclusionReason }) {
  return {
    isIncludableForRebuild: () => includable,
    explainExclusion: () => exclusionReason,
  };
}

test('classifyCandidate: URL not on disk at all is a gap', () => {
  const onDisk = new Map();
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: false }));
  assert.equal(r.state, 'gap');
  assert.equal(r.reason, null);
});

test('classifyCandidate: on-disk + includable is live', () => {
  const onDisk = new Map([['https://example.com/review', { data: {}, filePath: '/x.json' }]]);
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: true }));
  assert.equal(r.state, 'live');
});

test('classifyCandidate: on-disk + guard-excluded is named, not silently dropped', () => {
  const onDisk = new Map([['https://example.com/review', { data: { wrongProduction: true }, filePath: '/x.json' }]]);
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: false, exclusionReason: 'wrongProduction' }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'wrongProduction');
});

test('classifyCandidate: explainExclusion returning null on a non-includable file still names it', () => {
  // Defensive: explainExclusion is the single source of truth, but a caller
  // must never crash or silently swallow a review that's excluded for a
  // reason the predicate itself can't name.
  const onDisk = new Map([['https://example.com/review', { data: {}, filePath: '/x.json' }]]);
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: false, exclusionReason: null }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'unknown');
});

// ── URL normalization before live-comparison (task #907, evidence:
// theartsdesk.com's Sinatra review counted a gap over http vs https) ───────

test('classifyCandidate: scheme mismatch (http SERP result vs https on-disk) is LIVE, not a gap', () => {
  const onDisk = new Map([
    ['https://theartsdesk.com/new-reviews/frank-sinatra-review', { data: {}, filePath: '/x.json' }],
  ]);
  const r = classifyCandidate('http://theartsdesk.com/new-reviews/frank-sinatra-review', SHOW, onDisk, guardsFor({ includable: true }));
  assert.equal(r.state, 'live');
});

test('classifyCandidate: www-prefix mismatch is LIVE, not a gap', () => {
  const onDisk = new Map([
    ['https://theartsdesk.com/new-reviews/frank-sinatra-review', { data: {}, filePath: '/x.json' }],
  ]);
  const r = classifyCandidate('https://www.theartsdesk.com/new-reviews/frank-sinatra-review', SHOW, onDisk, guardsFor({ includable: true }));
  assert.equal(r.state, 'live');
});

test('classifyCandidate: trailing-slash mismatch is LIVE, not a gap', () => {
  const onDisk = new Map([
    ['https://theartsdesk.com/new-reviews/frank-sinatra-review', { data: {}, filePath: '/x.json' }],
  ]);
  const r = classifyCandidate('https://theartsdesk.com/new-reviews/frank-sinatra-review/', SHOW, onDisk, guardsFor({ includable: true }));
  assert.equal(r.state, 'live');
});

test('lookupRecord: exact match short-circuits before any canonicalization scan', () => {
  const onDisk = new Map([['https://example.com/review', { data: { marker: 1 } }]]);
  const rec = lookupRecord(onDisk, 'https://example.com/review');
  assert.equal(rec.data.marker, 1);
});

test('lookupRecord: a genuinely absent URL (no scheme/www/slash variant on disk either) is still null', () => {
  const onDisk = new Map([['https://example.com/other-review', { data: {} }]]);
  assert.equal(lookupRecord(onDisk, 'https://example.com/nope'), null);
});

// ── Non-review-page named exclusions (task #907, 6 of the first run's 9
// "gaps": ticketing/venue/listing pages, never a review) ────────────────────

test('classifyNonReviewUrl: ticketing reseller hosts are named, not a gap', () => {
  assert.equal(classifyNonReviewUrl('https://www.newyorkcitytheatre.com/some-show'), 'ticketing-reseller');
  assert.equal(classifyNonReviewUrl('https://newbrunswicktheater.com/tickets'), 'ticketing-reseller');
});

test('classifyNonReviewUrl: venue production page is named', () => {
  assert.equal(classifyNonReviewUrl('https://www.nationaltheatre.org.uk/productions/the-car-man'), 'venue-production-page');
});

test('classifyNonReviewUrl: event listing page is named', () => {
  assert.equal(classifyNonReviewUrl('https://middlesexcountyculture.com/event/the-car-man/'), 'event-listing');
});

test('classifyNonReviewUrl: londontheatre.co.uk /show/NNNN ticket page is named, but /reviews/ is NOT (it publishes real reviews)', () => {
  assert.equal(classifyNonReviewUrl('https://www.londontheatre.co.uk/show/1234/the-car-man'), 'ticketing-listing');
  assert.equal(classifyNonReviewUrl('https://www.londontheatre.co.uk/reviews/the-car-man'), null);
});

test('classifyNonReviewUrl: an ordinary outlet URL is not classified (returns null)', () => {
  assert.equal(classifyNonReviewUrl('https://theartsdesk.com/new-reviews/frank-sinatra-review'), null);
});

test('classifyNonReviewUrl: broadway.com ticketing pages are named (surfaced by the fix\'s own live re-run)', () => {
  assert.equal(classifyNonReviewUrl('https://www.broadway.com/shows/a-walk-on-the-moon/event/21764799/08-03-2026/1930/'), 'ticketing-reseller');
});

test('classifyNonReviewUrl: theatermania.com /shows/ is named, but its real /news/review-.../ path is NOT (it IS a registered outlet)', () => {
  assert.equal(classifyNonReviewUrl('https://www.theatermania.com/shows/new-york-city-theater/les-miserables-the-arena-concert-spectacular_1832919/'), 'venue-production-page');
  assert.equal(classifyNonReviewUrl('https://www.theatermania.com/news/review-camping-a-romantic-tragedy_1842335/'), null);
});

test('classifyNonReviewUrl: aggregator own-site show pages (show-score.com etc., canonical AGGREGATOR_DOMAINS set) are named', () => {
  assert.equal(classifyNonReviewUrl('https://www.show-score.com/off-broadway-shows/hershey-felder-the-piano-and-me'), 'aggregator-own-page');
  assert.equal(classifyNonReviewUrl('https://stagedoor.com/shows/some-show'), 'aggregator-own-page');
});

test('classifyCandidate: a ticketing/venue/listing URL not on disk is excluded (named), not a gap', () => {
  const onDisk = new Map();
  const r = classifyCandidate('https://www.nationaltheatre.org.uk/productions/the-car-man', SHOW, onDisk, guardsFor({ includable: false }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'venue-production-page');
});

// ── _pending/ quarantined files are named exclusions, not silent gaps
// (task #907: the-state-of-the-arts Car Man case — a 2015 prior-production
// review correctly quarantined by the #832 date guard) ─────────────────────

test('classifyCandidate: a pending-quarantined record is excluded with its quarantine reason', () => {
  const onDisk = new Map([
    ['https://www.thestateofthearts.co.uk/features/review-the-car-man', {
      data: { pendingReason: 'date_implausible' }, filePath: '/pending/x.json', pending: true, pendingReason: 'date_implausible',
    }],
  ]);
  const r = classifyCandidate('https://www.thestateofthearts.co.uk/features/review-the-car-man', SHOW, onDisk, guardsFor({ includable: false }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'quarantined: date_implausible');
});

test('classifyCandidate: pending record still resolves through scheme/www normalization', () => {
  const onDisk = new Map([
    ['https://thestateofthearts.co.uk/features/review-the-car-man', {
      data: {}, filePath: '/pending/x.json', pending: true, pendingReason: 'date_implausible',
    }],
  ]);
  const r = classifyCandidate('http://www.thestateofthearts.co.uk/features/review-the-car-man/', SHOW, onDisk, guardsFor({ includable: false }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'quarantined: date_implausible');
});

test('classifyCandidate: a no-byline pending record is excluded (already captured — not a gap) but its reason reads as an open queue item, not a settled exclusion', () => {
  // gather-reviews.js's no-byline strand (515 of 538 _pending files in the
  // live corpus at time of writing) is an active working queue, not a
  // permanent exclusion like date_implausible — the label must say so
  // (Codex ship-check finding, task #907: labeling both identically implies
  // "handled forever" for content that's actually still open).
  const onDisk = new Map([
    ['https://www.example-outlet.com/review-the-car-man', {
      data: {}, filePath: '/pending/x.json', pending: true, pendingReason: 'no-byline',
    }],
  ]);
  const r = classifyCandidate('https://www.example-outlet.com/review-the-car-man', SHOW, onDisk, guardsFor({ includable: false }));
  assert.equal(r.state, 'excluded');
  assert.match(r.reason, /no-byline/);
  assert.match(r.reason, /not a new gap/);
});

test('summarizeShow: passes with zero candidates', () => {
  const s = summarizeShow([]);
  assert.equal(s.pass, true);
});

test('summarizeShow: fails when any candidate is a gap', () => {
  const s = summarizeShow([
    { url: 'a', state: 'live' },
    { url: 'b', state: 'gap' },
    { url: 'c', state: 'excluded' },
  ]);
  assert.equal(s.pass, false);
  assert.equal(s.gaps.length, 1);
  assert.equal(s.live, 1);
  assert.equal(s.excluded, 1);
});

test('summarizeRun: no measured shows is inconclusive, never clean', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'settling', candidates: [] },
    { showId: 'b', sampleState: 'unknown-date', candidates: [] },
  ]);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.measured, 0);
});

test('summarizeRun: clean when every measured show passes', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'measured', onDiskCount: 3, candidates: [{ state: 'live' }] },
    { showId: 'b', sampleState: 'measured', onDiskCount: 2, candidates: [{ state: 'excluded' }] },
  ]);
  assert.equal(r.verdict, 'clean');
  assert.equal(r.measured, 2);
});

test('summarizeRun: gaps-found when at least one measured show has a real gap', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'measured', onDiskCount: 3, candidates: [{ state: 'live' }] },
    { showId: 'b', sampleState: 'measured', onDiskCount: 2, candidates: [{ state: 'gap' }] },
  ]);
  assert.equal(r.verdict, 'gaps-found');
  assert.deepEqual(r.gapShows, ['b']);
  assert.equal(r.gapCount, 1);
});

test('detectProviderOutage: no queries recorded is not an outage (nothing to judge)', () => {
  const o = detectProviderOutage([{ queries: [] }]);
  assert.equal(o.outage, false);
});

test('detectProviderOutage: every naive query failing is a real outage', () => {
  const o = detectProviderOutage([
    { queries: [{ ok: false, raw: 0 }, { ok: false, raw: 0 }] },
    { queries: [{ ok: false, raw: 0 }] },
  ]);
  assert.equal(o.outage, true);
});

test('detectProviderOutage: a mostly-healthy chain with one flaky query is not an outage', () => {
  const o = detectProviderOutage([
    { queries: [{ ok: true, raw: 8 }] },
    { queries: [{ ok: true, raw: 5 }] },
    { queries: [{ ok: false, raw: 0 }] },
  ]);
  assert.equal(o.outage, false);
});

test('onDiskUnavailable: zero on-disk records across every measured show means the checkout failed', () => {
  assert.equal(onDiskUnavailable([
    { sampleState: 'measured', onDiskCount: 0 },
    { sampleState: 'measured', onDiskCount: 0 },
  ]), true);
});

test('onDiskUnavailable: at least one measured show with on-disk records means the corpus is present', () => {
  assert.equal(onDiskUnavailable([
    { sampleState: 'measured', onDiskCount: 0 },
    { sampleState: 'measured', onDiskCount: 4 },
  ]), false);
});

test('onDiskUnavailable: no measured shows at all is not "unavailable" — summarizeRun already calls that inconclusive', () => {
  assert.equal(onDiskUnavailable([{ sampleState: 'settling', onDiskCount: 0 }]), false);
});

test('summarizeRun: a provider outage never reads as clean, even with zero candidates everywhere', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'measured', onDiskCount: 3, candidates: [], queries: [{ ok: false, raw: 0 }] },
    { showId: 'b', sampleState: 'measured', onDiskCount: 2, candidates: [], queries: [{ ok: false, raw: 0 }] },
  ]);
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reason, /provider outage/);
});

test('summarizeRun: a missing on-disk corpus never reads as gaps-found, even with candidates everywhere', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'measured', onDiskCount: 0, candidates: [{ state: 'gap' }], queries: [{ ok: true, raw: 5 }] },
    { showId: 'b', sampleState: 'measured', onDiskCount: 0, candidates: [{ state: 'gap' }], queries: [{ ok: true, raw: 5 }] },
  ]);
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reason, /on-disk review corpus unavailable/);
});

test('evaluateAcceptance: fewer than 2 measurable runs is not accepted', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-20', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /only 1 measurable/);
});

test('evaluateAcceptance: an inconclusive (outage) run does not count as evidence either way', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-06', generatedAt: '2026-07-06T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-13', generatedAt: '2026-07-13T00:00:00Z', verdict: 'inconclusive' },
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
  ]);
  // The two measurable entries (07-06, 07-20) are 14 days apart and both
  // clean — accepted, with the outage week correctly skipped rather than
  // resetting or completing the streak on its own.
  assert.equal(r.accepted, true);
});

test('evaluateAcceptance: a gaps-found run resets the streak', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-06', generatedAt: '2026-07-06T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-13', generatedAt: '2026-07-13T00:00:00Z', verdict: 'gaps-found', gapCount: 2, gapShows: ['x'] },
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /2026-07-13/);
});

test('evaluateAcceptance: two clean runs too close together (same-day re-trigger) is not accepted', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-20', generatedAt: '2026-07-20T04:00:00Z', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /not two distinct weekly cadences/);
});

test('evaluateAcceptance: two consecutive clean weeks, properly spaced, is accepted', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-13', generatedAt: '2026-07-13T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, true);
  assert.match(r.reason, /2 consecutive clean weekly run/);
});

// ── Trend-ledger union merge (task #784's race class, applied to #903) ──────

const { mergeCoverageAdversarialProbeTrend } = require('./merge-coverage-adversarial-probe-trend.js');
const { mergerFor } = require('./reconcile-merged-json.js');

test('the coverage-probe trend ledger is registered with the post-rebase reconciler', () => {
  // Without this registration, `rebase -X theirs` silently drops a concurrent
  // writer's line with no conflict reported — task #784's class, applied here
  // per a #903 ship-check finding (the first version of this sprint shipped
  // without it, unlike the analogous census-recall-trend.jsonl).
  assert.ok(mergerFor('data/audit/coverage-adversarial-probe-trend.jsonl'), 'not in the MANAGED registry');
});

test('merging keeps the better-evidenced (more shows measured) entry for a shared date and unions the rest', () => {
  const r = mergeCoverageAdversarialProbeTrend(
    [{ date: '2026-07-26', measured: 5 }, { date: '2026-08-02', measured: 5 }],
    [{ date: '2026-07-26', measured: 2 }, { date: '2026-08-09', measured: 5 }],
  );
  assert.deepEqual(r.merged.map(e => e.date), ['2026-07-26', '2026-08-02', '2026-08-09']);
  assert.equal(r.merged.find(e => e.date === '2026-07-26').measured, 5);
  assert.equal(r.stats.added, 1);
});

test('a remote entry that measured MORE shows wins the shared date', () => {
  const r = mergeCoverageAdversarialProbeTrend(
    [{ date: '2026-08-02', measured: 1 }],
    [{ date: '2026-08-02', measured: 5 }],
  );
  assert.equal(r.merged[0].measured, 5);
  assert.equal(r.stats.replaced, 1);
});

test('merging is idempotent — re-merging the same sides changes nothing', () => {
  const ours = [{ date: '2026-08-02', measured: 5 }];
  const remote = [{ date: '2026-08-02', measured: 5 }];
  const once = mergeCoverageAdversarialProbeTrend(ours, remote).merged;
  const twice = mergeCoverageAdversarialProbeTrend(once, remote).merged;
  assert.deepEqual(twice, once);
});
