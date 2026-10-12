// BRO-4290: rows the OWE promoter builds from audit review evidence are
// mostly closed runs (often with no openingDate) and nothing gathered their
// reviews: the catch-up selector was open-only. They now qualify for a
// bounded slot in the batch; ordinary closed zero-review rows still don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectCatchupCandidates, AUDIT_EVIDENCE_SOURCE } = require('../../scripts/lib/zero-review-catchup.js');

const NOW = Date.parse('2026-10-12T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const evidence = (id, extra = {}) => ({
  id, status: 'closed', openingDate: null, discoverySource: AUDIT_EVIDENCE_SOURCE,
  discoveredAt: daysAgo(5), evidenceUrls: [`https://example.com/review-${id}`], ...extra,
});
const open = (id) => ({ id, status: 'open', openingDate: daysAgo(10) });
const run = (shows, reviews = [], attempts = {}, opts = {}) =>
  selectCatchupCandidates(shows, reviews, attempts, { now: NOW, ...opts });

test('a closed evidence-promoted row with no openingDate is selected', () => {
  const r = run([evidence('ev-a')]);
  assert.deepEqual(r.batch, ['ev-a']);
  assert.deepEqual(r.evidence, ['ev-a']);
});

test('an ordinary closed zero-review row is still skipped', () => {
  const r = run([{ id: 'plain', status: 'closed', openingDate: daysAgo(30), discoveredAt: daysAgo(5) }]);
  assert.deepEqual(r.batch, []);
});

test('evidence source without evidenceUrls is skipped', () => {
  assert.deepEqual(run([evidence('no-urls', { evidenceUrls: [] })]).batch, []);
});

test('evidence rows with reviews, unparseable or old discoveredAt are skipped', () => {
  const r = run([
    evidence('has-review'),
    evidence('bad-date', { discoveredAt: 'not a date' }),
    evidence('old', { discoveredAt: daysAgo(200) }),
  ], [{ showId: 'has-review' }]);
  assert.deepEqual(r.batch, []);
  assert.deepEqual(r.tooOld, ['old']);
});

test('evidence rows honour noReviewsExpected and the attempt budget', () => {
  const r = run([evidence('exempt', { noReviewsExpected: true }), evidence('spent')],
    [], { spent: { attempts: 3, firstAt: daysAgo(3) } });
  assert.deepEqual(r.batch, []);
  assert.deepEqual(r.exempt, ['exempt']);
  assert.deepEqual(r.givenUp, ['spent']);
});

test('open rows go first; evidence rows are capped and never exceed batchSize', () => {
  const shows = [evidence('e1'), evidence('e2'), evidence('e3'), open('o1'), open('o2')];
  const r = run(shows);
  assert.deepEqual(r.batch, ['o1', 'o2', 'e1', 'e2']);
  assert.deepEqual(r.evidence, ['e1', 'e2']);
  const full = run([...shows, open('o3')], [], {}, { batchSize: 3 });
  assert.deepEqual(full.batch, ['o1', 'o2', 'o3']);
  assert.deepEqual(full.evidence, []);
});
