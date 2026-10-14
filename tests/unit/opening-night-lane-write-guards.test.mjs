// TESTS-VS-DERIVED-DATA-EXEMPT: structural; shows.json is read only to pick any show id/title/openingDate for fixtures, no fact is pinned
// BRO-4805 (epic BRO-4210, BRO-4782 wiring A): the write-time guards stand down for a lane review, and a slot collision
// with a flagged file writes a NEW file named by outlet + critic + night instead of merging. Real createOrMergeReviewFile
// and safeWriteReview, each driven with a lane review and an ordinary review of the same content (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tm = require('../../scripts/lib/opening-night-lane/trust-model.js');
const writer = require('../../scripts/lib/review-file-writer.js');
const writeGuard = require('../../scripts/lib/review-write-guard.js');

const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
const SHOW = shows.find((s) => s.category === 'broadway' && s.openingDate && /^[a-z0-9-]+$/.test(s.id) && String(s.openingDate) >= '2025-06-01');
const NIGHT = String(SHOW.openingDate).slice(0, 10);
const stamp = () => ({
  showId: SHOW.id,
  productionVerified: 'aggregator',
  openingNightLane: { show: SHOW.id, night: NIGHT, source: 'aggregator', seenAt: `${NIGHT}T22:00:00Z` },
});
const quiet = (fn) => { const log = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = log; } };
const body = `${'The performances were uneven but the staging was bold. '.repeat(20)}${SHOW.title}`;
const URL_A = 'https://variety.com/2026/legit/reviews/earlier-take-review-1111/';
const URL_B = 'https://variety.com/2026/legit/reviews/opening-night-take-review-2222/';
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** A temp review-texts root with the show dir and one existing variety file for the slot. */
function slotWith(existing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4805-'));
  const showDir = path.join(dir, SHOW.id);
  fs.mkdirSync(showDir, { recursive: true });
  const slot = path.join(showDir, 'variety--frank-rizzo.json');
  fs.writeFileSync(slot, JSON.stringify({ showId: SHOW.id, outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo', url: URL_A, fullText: body, ...existing }, null, 2));
  return { dir, showDir, slot, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}
const put = (s, url, fields) => quiet(() => writer.createOrMergeReviewFile(SHOW.id, { outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo', url, source: 'serp', fields: { fullText: body, ...fields } }, { reviewTextsDir: s.dir }));
const files = (s) => fs.readdirSync(s.showDir).sort();

test('a lane review colliding with a FLAGGED slot gets its own file named by outlet + critic + night; the flagged file is untouched', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const before = fs.readFileSync(s.slot, 'utf8');
    const r = put(s, URL_B, stamp());
    assert.equal(r.action, 'new');
    assert.equal(path.basename(r.filepath), `variety--frank-rizzo--on-${NIGHT}.json`);
    assert.equal(fs.readFileSync(s.slot, 'utf8'), before, 'the flagged slot file is byte-identical');
    const lane = read(r.filepath);
    assert.equal(lane.url, URL_B);
    assert.equal(lane.wrongProduction, undefined, 'the lane review did not inherit the flag');
    assert.equal(lane.productionVerified, 'aggregator');
    assert.deepEqual(files(s), [`variety--frank-rizzo--on-${NIGHT}.json`, 'variety--frank-rizzo.json']);
  } finally { s.cleanup(); }
});

test('re-running the same lane write is idempotent: the night file is found again, never a third file', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const first = put(s, URL_B, stamp());
    const again = put(s, URL_B, stamp());
    assert.equal(again.filepath, first.filepath);
    assert.equal(files(s).length, 2);
  } finally { s.cleanup(); }
});

test('a second lane review with another URL on the same slot and night gets a URL-hash name, not an overwrite', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const one = put(s, URL_B, stamp());
    const two = put(s, 'https://variety.com/2026/legit/reviews/second-voice-review-3333/', stamp());
    assert.notEqual(two.filepath, one.filepath);
    assert.equal(files(s).length, 3);
    assert.equal(read(one.filepath).url, URL_B, 'the first lane file keeps its review');
  } finally { s.cleanup(); }
});

test('an ordinary review with the same content on the flagged slot is NOT redirected: it merges into the existing file as before', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const r = put(s, URL_B, {});
    assert.ok(r.filepath, `expected a filepath, got ${JSON.stringify(r)}`);
    assert.equal(path.basename(r.filepath), 'variety--frank-rizzo.json');
    assert.deepEqual(files(s), ['variety--frank-rizzo.json'], 'no lane-named file for an ordinary review');
    assert.equal(read(s.slot).wrongProduction, true, 'the flag is still there');
  } finally { s.cleanup(); }
});

test('a half-stamped review is ordinary: no redirect', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const half = stamp(); delete half.productionVerified;
    put(s, URL_B, half);
    assert.deepEqual(files(s), ['variety--frank-rizzo.json']);
  } finally { s.cleanup(); }
});

test('a lane review for the SAME url as the flagged slot merges into it (it is the same review; a human flag is not bypassed by renaming)', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    put(s, URL_A, stamp());
    assert.deepEqual(files(s), ['variety--frank-rizzo.json']);
  } finally { s.cleanup(); }
});

test('a lane review on an UNFLAGGED slot with another url is not redirected either (only a flagged file is walked around)', () => {
  const s = slotWith({});
  try {
    put(s, URL_B, stamp());
    assert.ok(!files(s).some((f) => f.includes('--on-')), files(s).join(','));
  } finally { s.cleanup(); }
});

test('rejected and duplicateOf slots count as flagged too', () => {
  for (const flag of [{ rejectionReason: 'garbage_text' }, { duplicateOf: 'variety--someone-else.json' }]) {
    const s = slotWith(flag);
    try {
      const r = put(s, URL_B, stamp());
      assert.equal(path.basename(r.filepath), `variety--frank-rizzo--on-${NIGHT}.json`, JSON.stringify(flag));
    } finally { s.cleanup(); }
  }
});

test('after a lane file exists, an ORDINARY write for the same critic never merges into it (it keeps its own slot)', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const lane = put(s, URL_B, stamp());
    const laneBefore = fs.readFileSync(lane.filepath, 'utf8');
    // An ordinary re-scrape of the OLD flagged review, and an ordinary write for a third URL.
    for (const url of [URL_A, 'https://variety.com/2026/legit/reviews/third-take-review-4444/']) {
      const r = put(s, url, { assignedScore: 40 });
      assert.notEqual(r.filepath, lane.filepath, `ordinary write for ${url} must not land on the lane file`);
    }
    assert.equal(fs.readFileSync(lane.filepath, 'utf8'), laneBefore, 'the lane file is byte-identical');
  } finally { s.cleanup(); }
});

test('findExistingReviewFile finds a lane night file by its URL and by nothing else', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const lane = put(s, URL_B, stamp());
    const { findExistingReviewFile } = require('../../scripts/lib/review-normalization.js');
    assert.equal(findExistingReviewFile(s.showDir, 'variety', 'Frank Rizzo', URL_B).path, lane.filepath);
    const other = findExistingReviewFile(s.showDir, 'variety', 'Frank Rizzo', 'https://variety.com/2026/legit/reviews/elsewhere-review-5555/');
    assert.ok(!other || other.path !== lane.filepath);
  } finally { s.cleanup(); }
});

test('a redirected lane create still faces the listing-page guard (it is not a lane-exempt guard)', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const r = put(s, 'https://www.express.co.uk/entertainment/theatre', stamp());
    assert.equal(r.action, 'skipped');
    assert.match(r.reason, /listing-page-url/);
    assert.deepEqual(files(s), ['variety--frank-rizzo.json']);
  } finally { s.cleanup(); }
});

test('dryRun with a redirect writes nothing; the real write then reuses the same name', () => {
  const s = slotWith({ wrongProduction: true, wrongProductionNote: 'earlier corpus verdict' });
  try {
    const dry = quiet(() => writer.createOrMergeReviewFile(SHOW.id, { outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo', url: URL_B, source: 'serp', fields: { fullText: body, ...stamp() } }, { reviewTextsDir: s.dir, dryRun: true }));
    assert.deepEqual(files(s), ['variety--frank-rizzo.json'], 'a dry run created no file');
    const real = put(s, URL_B, stamp());
    assert.equal(path.basename(real.filepath), `variety--frank-rizzo--on-${NIGHT}.json`);
    assert.ok(dry);
  } finally { s.cleanup(); }
});

test('safeWriteReview date-plausibility stamp: a lane review is not auto-flagged wrongProduction when its date arrives after scoring; an ordinary one is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4805w-'));
  try {
    const showDir = path.join(dir, SHOW.id);
    fs.mkdirSync(showDir, { recursive: true });
    const run = (name, extra) => {
      const fp = path.join(showDir, `variety--${name}.json`);
      const base = { showId: SHOW.id, outletId: 'variety', criticName: name, url: `https://variety.com/2012/legit/reviews/${name}-review-9999/`, fullText: body, assignedScore: 80, ...extra };
      fs.writeFileSync(fp, JSON.stringify(base)); // already scored, no publishDate yet
      quiet(() => writeGuard.safeWriteReview(fp, { ...base, publishDate: '2012-03-04' })); // the date arrives, far before the show's earliest date
      return read(fp);
    };
    assert.equal(run('lane', stamp()).wrongProduction, undefined, 'lane review stands');
    assert.equal(run('ord', {}).wrongProduction, true, 'the same content as an ordinary review is stamped by the date guard');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('the redirect uses the real contract: laneReviewFilename and laneBypasses', () => {
  assert.equal(tm.laneReviewFilename({ outletId: 'variety', criticName: 'Frank Rizzo', night: NIGHT, url: URL_B }).filename, `variety--frank-rizzo--on-${NIGHT}.json`);
  assert.equal(tm.laneBypasses({ ...stamp() }, 'wrongProduction', { openingDate: NIGHT }), true);
});
