// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-7082: create-time origin stamp. Requires the real modules (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const prov = require(path.join(repoRoot, 'scripts/lib/review-provenance.js'));
const { safeWriteReview } = require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));
const { PROTECTED_FIELDS } = require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));

test('originFor: named callers decide, hand callers are manual', () => {
  assert.deepEqual(prov.originFor({ data: { ingestSource: 'execute-approved-fix' } }), { origin: 'manual', by: 'execute-approved-fix' });
  assert.deepEqual(prov.originFor({ data: {}, env: { INGEST_CALLER: 'tic-daily' } }), { origin: 'automated', by: 'tic-daily' });
  assert.equal(prov.originFor({ data: { ingestSource: 'owner' } }).origin, 'manual');
});

test('originFor: a collector source is automated; caller-decides sources with no caller stay unknown', () => {
  assert.equal(prov.originFor({ data: { source: 'opening-night-poller' } }).origin, 'automated');
  for (const source of ['ingest-urls', 'submit-review-form', 'manual-entry']) {
    assert.equal(prov.originFor({ data: { source } }).origin, 'unknown', source);
  }
  assert.equal(prov.originFor({ data: {} }).origin, 'unknown');
});

test('originFor: never guesses from the runner (GITHUB_ACTIONS / CI do not matter)', () => {
  assert.equal(prov.originFor({ data: { source: 'ingest-urls' }, env: { GITHUB_ACTIONS: 'true', CI: 'true' } }).origin, 'unknown');
  assert.equal(prov.originFor({ data: { source: 'ingest-urls' }, env: {} }).origin, 'unknown');
});

test('originFor: explicit and env overrides win; junk callers are ignored', () => {
  assert.equal(prov.originFor({ data: { ingestOrigin: 'manual', source: 'gather-reviews' } }).origin, 'manual');
  assert.equal(prov.originFor({ data: { source: 'gather-reviews' }, env: { INGEST_ORIGIN: 'manual' } }).origin, 'manual');
  assert.equal(prov.sanitizeCaller('tic-daily'), 'tic-daily');
  assert.equal(prov.sanitizeCaller('$(rm -rf /)'), null);
  assert.equal(prov.sanitizeCaller('a`b`'), null);
  assert.equal(prov.originFor({ data: { source: 'ingest-urls' }, env: { INGEST_CALLER: '$(x)' } }).origin, 'unknown');
});

test('stampIngestOrigin: kill switch, idempotent, never throws', () => {
  const d = { source: 'gather-reviews' };
  assert.equal(prov.stampIngestOrigin(d, { REVIEW_ORIGIN_STAMP: 'off' }), false);
  assert.equal(d.ingestOrigin, undefined);
  assert.equal(prov.stampIngestOrigin(d, {}), true);
  assert.equal(d.ingestOrigin, 'automated');
  assert.equal(prov.stampIngestOrigin(d, { INGEST_ORIGIN: 'manual' }), false, 'an existing stamp is never rewritten');
  assert.equal(d.ingestOrigin, 'automated');
  const hostile = Object.defineProperty({}, 'source', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => prov.stampIngestOrigin(hostile, {}));
  assert.equal(prov.stampIngestOrigin(null, {}), false);
});

test('origin fields stay out of PROTECTED_FIELDS (stub quarantine + staged-deletion protection key off it)', () => {
  assert.ok(!PROTECTED_FIELDS.includes('ingestOrigin'));
  assert.ok(!PROTECTED_FIELDS.includes('ingestOriginBy'));
  const action = fs.readFileSync(path.join(repoRoot, '.github/actions/push-review-texts/action.yml'), 'utf8');
  const extra = action.match(/const\s+ACTION_EXTRA\s*=\s*\[([\s\S]*?)\];/)[1];
  assert.match(extra, /'ingestOrigin'/, 'rebase protection at push time');
  const restore = fs.readFileSync(path.join(repoRoot, 'scripts/lib/restore-protected-fields.js'), 'utf8');
  assert.match(restore, /'ingestOrigin',/);
});

function tmpShowDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7082-'));
  const dir = path.join(root, 'test-show-2026');
  fs.mkdirSync(dir);
  return dir;
}
const review = (extra = {}) => ({
  showId: 'test-show-2026', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jane Doe',
  url: 'https://www.nytimes.com/2026/11/01/theater/test-show-review.html', publishDate: '2026-11-01',
  source: 'opening-night-poller', ...extra,
});

test('safeWriteReview stamps origin on create only', () => {
  const dir = tmpShowDir();
  const fp = path.join(dir, 'nytimes--jane-doe.json');
  const prev = { o: process.env.INGEST_ORIGIN, c: process.env.INGEST_CALLER, k: process.env.REVIEW_ORIGIN_STAMP };
  delete process.env.INGEST_ORIGIN; delete process.env.INGEST_CALLER; delete process.env.REVIEW_ORIGIN_STAMP;
  try {
    const r = safeWriteReview(fp, review());
    assert.equal(r.wrote, true);
    const created = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(created.ingestOrigin, 'automated');
    assert.equal(created.ingestOriginBy, 'source:opening-night-poller');

    // A later hand write to the existing file does not re-stamp creation.
    process.env.INGEST_ORIGIN = 'manual';
    const { ingestOrigin, ingestOriginBy, ...rest } = created;
    safeWriteReview(fp, { ...rest, criticName: 'Jane Doe' });
    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(after.ingestOrigin, 'automated', 'the create-time stamp survives a later write');

    // Kill switch: create without stamp.
    process.env.REVIEW_ORIGIN_STAMP = 'off';
    const fp2 = path.join(dir, 'variety--john-roe.json');
    safeWriteReview(fp2, review({ outletId: 'variety', outlet: 'Variety', criticName: 'John Roe', url: 'https://variety.com/2026/legit/reviews/test-show-1236000000/' }));
    assert.equal(JSON.parse(fs.readFileSync(fp2, 'utf8')).ingestOrigin, undefined);
  } finally {
    for (const [k, v] of [['INGEST_ORIGIN', prev.o], ['INGEST_CALLER', prev.c], ['REVIEW_ORIGIN_STAMP', prev.k]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
