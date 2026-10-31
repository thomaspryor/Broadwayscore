// BRO-4290: rows the OWE promoter builds from audit review evidence are
// mostly closed runs (often with no openingDate) and nothing gathered their
// reviews. They are picked by selectEvidenceSeedCandidates for the capped
// one-fetch seeder (scripts/seed-evidence-review-stubs.js), not by the
// gather catch-up. Ordinary closed zero-review rows (never 'open' during a
// daily run, so never gathered before) get exactly one gather catch-up try.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectCatchupCandidates, selectEvidenceSeedCandidates, AUDIT_EVIDENCE_SOURCE,
  DEFAULT_EVIDENCE_PER_BATCH, MAX_EVIDENCE_PER_BATCH,
  DEFAULT_CLOSED_BACKFILL_PER_BATCH, MAX_CLOSED_BACKFILL_PER_BATCH,
} = require('../../scripts/lib/zero-review-catchup.js');

const NOW = Date.parse('2026-10-12T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const evidence = (id, extra = {}) => ({
  id, status: 'closed', openingDate: null, discoverySource: AUDIT_EVIDENCE_SOURCE,
  discoveredAt: daysAgo(5), evidenceUrls: [`https://example.com/review-${id}`], ...extra,
});
const open = (id) => ({ id, status: 'open', openingDate: daysAgo(10) });
const seed = (shows, reviews = [], fetched = new Set(), opts = {}) =>
  selectEvidenceSeedCandidates(shows, reviews, fetched, { now: NOW, ...opts });
const ids = (r) => r.batch.map((c) => c.id);

test('a closed evidence-promoted row with no openingDate is selected with its evidence URL', () => {
  const r = seed([evidence('ev-a')]);
  assert.deepEqual(r.batch, [{ id: 'ev-a', url: 'https://example.com/review-ev-a' }]);
});

test('the gather catch-up no longer takes evidence rows (its spend is uncapped)', () => {
  const r = selectCatchupCandidates([evidence('ev-a'), open('o1')], [], {}, { now: NOW });
  assert.deepEqual(r.batch, ['o1']);
});

const closed = (id, extra = {}) => ({ id, status: 'closed', openingDate: daysAgo(30), discoveredAt: daysAgo(5), ...extra });
const pick = (shows, attempts = {}, opts = {}) => selectCatchupCandidates(shows, [], attempts, { now: NOW, ...opts });

test('an ordinary closed zero-review row is not seeded but gets one gather catch-up try', () => {
  const plain = closed('plain');
  assert.deepEqual(ids(seed([plain])), []);
  const r = pick([plain]);
  assert.deepEqual(r.batch, ['plain']);
  assert.deepEqual(r.closedBackfill, ['plain']);
  assert.deepEqual(pick([plain], { plain: { attempts: 1, firstAt: daysAgo(1) } }).batch, []);
});

test('closed backfill is capped after the open rows and ordered by run length', () => {
  const shows = [
    closed('short', { closingDate: daysAgo(28) }),
    closed('long', { closingDate: daysAgo(2) }),
    closed('mid', { closingDate: daysAgo(15) }),
    open('o1'),
  ];
  const r = pick(shows);
  assert.equal(DEFAULT_CLOSED_BACKFILL_PER_BATCH, 2);
  assert.deepEqual(r.batch, ['o1', 'long', 'mid']);
  assert.deepEqual(r.closedEligible, ['long', 'mid', 'short']);
  // Closed slots are reserved: a full open queue cannot starve them.
  assert.deepEqual(pick(shows, {}, { batchSize: 1 }).batch, ['long']);
  const manyOpen = [...Array.from({ length: 12 }, (_, i) => open(`o${i}`)), closed('c1')];
  const full = pick(manyOpen);
  assert.equal(full.batch.length, 10);
  assert.deepEqual(full.closedBackfill, ['c1']);
  assert.equal(pick(shows, {}, { closedPerBatch: 99 }).closedBackfill.length, Math.min(3, MAX_CLOSED_BACKFILL_PER_BATCH));
});

test('closed rows past the age bound or inside the grace window are skipped silently', () => {
  const r = pick([closed('old', { openingDate: daysAgo(200) }), closed('fresh', { openingDate: daysAgo(1) })]);
  assert.deepEqual(r.batch, []);
  assert.deepEqual(r.tooOld, []);
  assert.deepEqual(r.stranded, []);
});

test('a closed row with only previewsStartDate is aged from it', () => {
  assert.deepEqual(pick([closed('p', { openingDate: null, previewsStartDate: daysAgo(20) })]).batch, ['p']);
});

test('a row with only closingDate is aged from it; an open one closing later waits', () => {
  const r = pick([
    closed('c-only', { openingDate: null, closingDate: daysAgo(20) }),
    { id: 'o-later', status: 'open', closingDate: new Date(NOW + 2 * 86400000).toISOString() },
  ]);
  assert.deepEqual(r.batch, ['c-only']);
  assert.deepEqual(r.undated, []);
});

test('undated open/closed rows are reported as undated and stranded; exempt wins', () => {
  const r = pick([
    closed('u1', { openingDate: null }),
    { id: 'u2', status: 'open' },
    closed('ex', { openingDate: null, noReviewsExpected: true }),
  ]);
  assert.deepEqual(r.undated, ['u1', 'u2']);
  assert.deepEqual(r.exempt, ['ex']);
  assert.ok(r.stranded.includes('u1') && r.stranded.includes('u2') && !r.stranded.includes('ex'));
});

test('an open row left out past grace + 14 days is stranded; one at the boundary or batched is not', () => {
  const r = pick([open('o-in'), { ...open('o-old'), openingDate: daysAgo(18) }, { ...open('o-edge'), openingDate: daysAgo(17) }],
    {}, { batchSize: 1, closedPerBatch: 0 });
  assert.deepEqual(r.batch, ['o-in']);
  assert.deepEqual(r.stranded, ['o-old']);
});

test('a closed row is stranded only when the capped queue reaches it after the age bound', () => {
  // 3 closed rows, 1 per run: positions 0,1,2 need 0,1,2 more runs.
  const shows = [
    closed('a', { openingDate: daysAgo(30), closingDate: daysAgo(1) }),
    closed('b', { openingDate: daysAgo(89), closingDate: daysAgo(20) }),
    closed('c', { openingDate: daysAgo(90), closingDate: daysAgo(88) }),
  ];
  const r = pick(shows, {}, { closedPerBatch: 1 });
  assert.deepEqual(r.closedEligible, ['b', 'a', 'c']); // run length 69, 29, 2
  assert.deepEqual(r.batch, ['b']);
  // 'a' (position 1, 60 days of room) is fine; 'c' (position 2, 0 days of room) is stranded.
  assert.deepEqual(r.stranded, ['c']);
  // Not stranded on day one just because the opening is weeks back.
  assert.deepEqual(pick([closed('x'), closed('y'), closed('z')]).stranded, []);
});

test('tooOld, givenUp and exempt rows never count as stranded; old undated closed runs are dropped', () => {
  const r = pick([
    { ...open('old'), openingDate: daysAgo(200) },
    open('gave-up'),
    { ...open('ex'), noReviewsExpected: true },
    closed('ancient-undated', { openingDate: null, closingDate: daysAgo(400) }),
  ], { 'gave-up': { attempts: 3, firstAt: daysAgo(5) } });
  assert.deepEqual(r.tooOld, ['old']);
  assert.deepEqual(r.givenUp, ['gave-up']);
  assert.deepEqual(r.undated, []);
  assert.deepEqual(r.stranded, []);
});

test('evidence source without evidenceUrls is skipped', () => {
  assert.deepEqual(ids(seed([evidence('no-urls', { evidenceUrls: [] })])), []);
});

test('evidence rows with reviews, unparseable or old discoveredAt, or not closed are skipped', () => {
  const r = seed([
    evidence('has-review'),
    evidence('bad-date', { discoveredAt: 'not a date' }),
    evidence('old', { discoveredAt: daysAgo(200) }),
    evidence('upcoming', { status: 'upcoming' }),
  ], [{ showId: 'has-review' }]);
  assert.deepEqual(ids(r), []);
});

test('noReviewsExpected is exempt and an already-fetched show is never fetched again', () => {
  const r = seed([evidence('exempt', { noReviewsExpected: true }), evidence('done'), evidence('new')],
    [], new Set(['done']));
  assert.deepEqual(ids(r), ['new']);
  assert.deepEqual(r.exempt, ['exempt']);
});

test('at most 2 per job by default, never more than 5 even when asked', () => {
  const many = Array.from({ length: 8 }, (_, i) => evidence(`e${i}`));
  assert.equal(DEFAULT_EVIDENCE_PER_BATCH, 2);
  assert.deepEqual(ids(seed(many)), ['e0', 'e1']);
  assert.equal(seed(many, [], new Set(), { limit: 50 }).batch.length, MAX_EVIDENCE_PER_BATCH);
  assert.equal(seed(many).eligible, 8);
});
