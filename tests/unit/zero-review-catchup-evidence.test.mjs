// BRO-4290: rows the OWE promoter builds from audit review evidence are
// mostly closed runs (often with no openingDate) and nothing gathered their
// reviews. They are picked by selectEvidenceSeedCandidates for the capped
// one-fetch seeder (scripts/seed-evidence-review-stubs.js), not by the
// uncapped gather catch-up; ordinary closed zero-review rows are skipped by both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectCatchupCandidates, selectEvidenceSeedCandidates, AUDIT_EVIDENCE_SOURCE,
  DEFAULT_EVIDENCE_PER_BATCH, MAX_EVIDENCE_PER_BATCH,
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

test('an ordinary closed zero-review row is skipped by both selectors', () => {
  const plain = { id: 'plain', status: 'closed', openingDate: daysAgo(30), discoveredAt: daysAgo(5) };
  assert.deepEqual(ids(seed([plain])), []);
  assert.deepEqual(selectCatchupCandidates([plain], [], {}, { now: NOW }).batch, []);
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
