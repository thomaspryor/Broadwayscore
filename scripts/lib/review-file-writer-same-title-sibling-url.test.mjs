// BRO-5298: a write whose url a same-title sibling production already holds
// (live) is refused, on the CREATE path and, the gap this card closed, on the
// MERGE path (an existing outlet+critic file here that would fill or swap its
// url onto the sibling's). Found as 10 pairs by BRO-4674, e.g. the 2025 Times
// review counted again on the-comedy-about-spies-west-end-2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { siblingUrlHolder, isDeclaredPriorRunPair } = require('./sibling-same-url.js');
const { _resetUrlOwnershipIndex } = require('./url-ownership.js');
const { buildSiblingIndex } = require('./market-routing.js');

// ─── Pure decision (synthetic index, no corpus needed) ───
const SHOWS = [
  { id: 'spies-2025', title: 'Spies', openingDate: '2025-05-01', venue: 'Noel Coward Theatre' },
  { id: 'spies-2026', title: 'Spies', openingDate: '2026-06-01', venue: 'Adelphi Theatre' },
  { id: 'carol-2025', title: 'Carol', openingDate: '2025-12-14', venue: 'Apollo Theatre' },
  { id: 'carol-2026', title: 'Carol', openingDate: '2026-11-01', venue: "Wyndham's Theatre",
    priorRuns: [{ id: 'carol-2025', venue: 'Apollo Theatre' }] },
  { id: 'other-2026', title: 'Something Else', openingDate: '2026-01-01' },
];
const IDX = buildSiblingIndex(SHOWS);
const live = (showId, file = 'times-uk--clive-davis.json') => ({ showId, file, blocking: true, splitGroup: null, splitShows: null });

test('pure: a live copy in a same-title sibling is the holder', () => {
  assert.deepEqual(siblingUrlHolder({ showId: 'spies-2026', owners: [live('spies-2025')], siblingIndex: IDX }),
    { showId: 'spies-2025', file: 'times-uk--clive-davis.json' });
});

test('pure: a copy under a different title is not this guard\'s (Guard I judges it)', () => {
  assert.equal(siblingUrlHolder({ showId: 'spies-2026', owners: [live('other-2026')], siblingIndex: IDX }), null);
});

test('pure: a flagged / roundup sibling copy does not hold the url', () => {
  assert.equal(siblingUrlHolder({ showId: 'spies-2026', owners: [{ ...live('spies-2025'), blocking: false }], siblingIndex: IDX }), null);
});

test('pure: url already in this show\'s folder: the pair exists, do not refuse (lets it self-heal)', () => {
  assert.equal(siblingUrlHolder({ showId: 'spies-2026', owners: [live('spies-2025')], siblingIndex: IDX, targetHoldsUrl: true }), null);
});

test('pure: market routing rerouted this write away from the sibling: routing wins', () => {
  assert.equal(siblingUrlHolder({ showId: 'spies-2026', owners: [live('spies-2025')], siblingIndex: IDX, visited: new Set(['spies-2025']) }), null);
});

test('pure: declared prior-run pair is exempt, in both directions', () => {
  assert.equal(isDeclaredPriorRunPair('carol-2026', 'carol-2025', IDX), true);
  assert.equal(isDeclaredPriorRunPair('carol-2025', 'carol-2026', IDX), true);
  assert.equal(isDeclaredPriorRunPair('spies-2026', 'spies-2025', IDX), false);
  assert.equal(siblingUrlHolder({ showId: 'carol-2025', owners: [live('carol-2026')], siblingIndex: IDX }), null);
});

test('pure: a show with no sibling never refuses', () => {
  assert.equal(siblingUrlHolder({ showId: 'other-2026', owners: [live('spies-2025')], siblingIndex: IDX }), null);
});

// ─── Real writer, real shows.json pair, temp corpus ───
const OLD = 'the-comedy-about-spies-west-end-2025';
const NEW = 'the-comedy-about-spies-west-end-2026';
const URL_ = 'https://www.thetimes.com/culture/theatre-dance/article/the-comedy-about-spies-review-bro5298-test';
let haveShows = false;
try {
  // fs read, not require(): shows.json is core data, not a code dependency (audit-test-yml-lib-deps).
  const showsPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'shows.json');
  const ids = new Set(JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows.map((s) => s.id));
  haveShows = ids.has(OLD) && ids.has(NEW);
} catch { /* no core data checkout */ }
const skip = haveShows ? false : 'needs data/shows.json with the Comedy About Spies pair';

function corpus(files) {
  _resetUrlOwnershipIndex();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5298-'));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data, null, 2));
  }
  return dir;
}
const siblingCopy = (extra = {}) => ({
  showId: OLD, outletId: 'times-uk', outlet: 'The Times', criticName: 'Clive Davis', url: URL_,
  source: 'playbill-verdict', fullText: 'x '.repeat(400), assignedScore: 80, ...extra,
});
const incoming = (extra = {}) => ({
  outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', url: URL_, source: 'serp-discovery', ...extra,
});
const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

test('create: a new file whose url the sibling holds is refused', { skip }, () => {
  const dir = corpus({ [`${OLD}/times-uk--clive-davis.json`]: siblingCopy() });
  try {
    const r = createOrMergeReviewFile(NEW, incoming(), { reviewTextsDir: dir });
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, `cross-show-url-owned:${OLD}`);
    assert.equal(r.siblingFile, `${OLD}/times-uk--clive-davis.json`);
    assert.equal(fs.existsSync(path.join(dir, NEW)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('merge: an existing url-less file here is NOT given the sibling\'s url', { skip }, () => {
  const stub = { showId: NEW, outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', url: null,
    source: 'show-score', showScoreExcerpt: 'A tight, clever spy caper.' };
  const dir = corpus({
    [`${OLD}/times-uk--clive-davis.json`]: siblingCopy(),
    [`${NEW}/times-uk--unknown.json`]: stub,
  });
  try {
    const r = createOrMergeReviewFile(NEW, incoming({ fields: { fullText: 'y '.repeat(400) } }), { reviewTextsDir: dir });
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, `cross-show-url-owned:${OLD}`);
    assert.deepEqual(readJson(dir, `${NEW}/times-uk--unknown.json`), stub, 'target file untouched');
    assert.equal(readJson(dir, `${OLD}/times-uk--clive-davis.json`).assignedScore, 80, 'sibling copy untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('merge: a file here that already carries the url still merges (pair is the audit\'s)', { skip }, () => {
  const here = { showId: NEW, outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', url: URL_, source: 'serp-discovery' };
  const dir = corpus({
    [`${OLD}/times-uk--clive-davis.json`]: siblingCopy(),
    [`${NEW}/times-uk--unknown.json`]: here,
  });
  try {
    const r = createOrMergeReviewFile(NEW, incoming({ fields: { showScoreExcerpt: 'New excerpt.' } }), { reviewTextsDir: dir });
    assert.notEqual(r.reason, `cross-show-url-owned:${OLD}`);
    assert.equal(r.action, 'updated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a wrongProduction-flagged sibling copy does not block (the re-home case)', { skip }, () => {
  const dir = corpus({ [`${OLD}/times-uk--clive-davis.json`]: siblingCopy({ wrongProduction: true }) });
  try {
    const r = createOrMergeReviewFile(NEW, incoming(), { reviewTextsDir: dir, dryRun: true });
    assert.notEqual(r.action, 'skipped', JSON.stringify(r));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('escape hatches: allowCrossShowUrl and manual-entry are not refused by this guard', { skip }, () => {
  const dir = corpus({
    [`${OLD}/times-uk--clive-davis.json`]: siblingCopy(),
    [`${NEW}/times-uk--unknown.json`]: { showId: NEW, outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', url: null, source: 'show-score' },
  });
  try {
    const a = createOrMergeReviewFile(NEW, incoming({ fields: { allowCrossShowUrl: true } }), { reviewTextsDir: dir, dryRun: true });
    assert.notEqual(a.reason, `cross-show-url-owned:${OLD}`);
    const m = createOrMergeReviewFile(NEW, incoming({ source: 'manual-entry' }), { reviewTextsDir: dir, dryRun: true });
    assert.notEqual(m.reason, `cross-show-url-owned:${OLD}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('merge: a ?srsltid= / www variant of the url already here counts as "already here" (review finding)', { skip }, () => {
  const variant = URL_.replace('https://www.', 'https://') + '?srsltid=AfmBOoqTEST';
  const here = { showId: NEW, outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', url: variant, source: 'serp-discovery' };
  const dir = corpus({
    [`${OLD}/times-uk--clive-davis.json`]: siblingCopy(),
    [`${NEW}/times-uk--unknown.json`]: here,
  });
  try {
    const r = createOrMergeReviewFile(NEW, incoming({ fields: { showScoreExcerpt: 'New excerpt.' } }), { reviewTextsDir: dir, dryRun: true });
    assert.notEqual(r.reason, `cross-show-url-owned:${OLD}`, JSON.stringify(r));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
