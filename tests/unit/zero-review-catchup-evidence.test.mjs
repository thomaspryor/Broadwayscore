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
  assert.deepEqual(pick(shows, {}, { batchSize: 1 }).batch, ['o1']);
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

test('a never-attempted row waiting past grace + 14 days is stranded; a batched one is not', () => {
  const r = pick([closed('a'), closed('b'), closed('c', { openingDate: daysAgo(10) })], {}, { closedPerBatch: 1 });
  assert.deepEqual(r.batch, ['a']);
  assert.deepEqual(r.stranded, ['b']);
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
