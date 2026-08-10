// Tests for the newsletter pre-send image + review-completeness gates
// (task #823). Requires the REAL functions (CLAUDE.md §15) — no re-implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
  missingImageViolations,
  localPathForImageUrl,
  phantomImageViolations,
  countEmptyImgSrc,
  extractSiteImageUrls,
  classifyGapEntry,
  completenessFindings,
  gapDisclosureDecisions,
  openingsPreserved,
} = createRequire(import.meta.url)('./newsletter-preflight.js');

const NOW = Date.parse('2026-08-02T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('missingImageViolations flags null-image featured shows only', () => {
  const out = missingImageViolations([
    { id: 'brainiac-live-west-end-2026', title: 'Brainiac Live!', image: null },
    { id: 'ok-show', title: 'Fine', image: 'https://broadwayscorecard.com/images/shows/ok-show/thumbnail.webp' },
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0], /Brainiac Live!/);
  assert.match(out[0], /placeholder/);
  assert.deepEqual(missingImageViolations([]), []);
  assert.deepEqual(missingImageViolations(undefined), []);
});

test('localPathForImageUrl maps site URLs to public/ and rejects foreign URLs', () => {
  assert.equal(
    localPathForImageUrl('https://broadwayscorecard.com/images/shows/x/thumbnail.webp'),
    'public/images/shows/x/thumbnail.webp'
  );
  assert.equal(localPathForImageUrl('https://broadwayscorecard.com/images/a/b.jpg?v=2'), 'public/images/a/b.jpg');
  assert.equal(localPathForImageUrl('https://example.com/images/x.jpg'), null);
  assert.equal(localPathForImageUrl(null), null);
});

test('phantomImageViolations flags metadata pointing at missing files', () => {
  const shows = [
    { id: 'ghost', title: 'Ghost Art', image: 'https://broadwayscorecard.com/images/shows/ghost/thumbnail.webp' },
    { id: 'real', title: 'Real Art', image: 'https://broadwayscorecard.com/images/shows/real/thumbnail.webp' },
    { id: 'no-img', title: 'No Image', image: null }, // missingImageViolations' job, not this one's
  ];
  const out = phantomImageViolations(shows, (rel) => rel.includes('/real/'));
  assert.equal(out.length, 1);
  assert.match(out[0], /Ghost Art/);
  assert.match(out[0], /phantom path/);
});

test('phantomImageViolations checks the poster too (posterOrThumb renders it when declared)', () => {
  const shows = [{
    id: 'x', title: 'Phantom Poster',
    image: 'https://broadwayscorecard.com/images/shows/x/thumbnail.webp',   // real
    poster: 'https://broadwayscorecard.com/images/shows/x/poster.webp',     // phantom
  }];
  const out = phantomImageViolations(shows, (rel) => rel.endsWith('thumbnail.webp'));
  assert.equal(out.length, 1);
  assert.match(out[0], /poster points at/);
});

test('countEmptyImgSrc counts only empty-src img tags', () => {
  const html = '<img width="56" src="" alt=""><img src="https://broadwayscorecard.com/i.jpg"><div src=""></div><img class="x" src="">';
  assert.equal(countEmptyImgSrc(html), 2);
  assert.equal(countEmptyImgSrc('<p>none</p>'), 0);
});

test('extractSiteImageUrls dedupes and ignores foreign hosts', () => {
  const html = `
    <img src="https://broadwayscorecard.com/images/shows/a/thumbnail.webp">
    <img width="56" src="https://broadwayscorecard.com/images/shows/a/thumbnail.webp">
    <img src="https://www.google.com/s2/favicons?domain=x&sz=64">
    <img src="https://broadwayscorecard.com/images/shows/b/poster.webp">`;
  const urls = extractSiteImageUrls(html);
  assert.deepEqual(urls.sort(), [
    'https://broadwayscorecard.com/images/shows/a/thumbnail.webp',
    'https://broadwayscorecard.com/images/shows/b/poster.webp',
  ]);
});

test('classifyGapEntry: fresh gap / fresh ok / stale / no-data', () => {
  assert.equal(classifyGapEntry({ at: hoursAgo(2), gaps: 3, uncollected: 3 }, NOW), 'gap');
  assert.equal(classifyGapEntry({ at: hoursAgo(2), gaps: 0, uncollected: 0 }, NOW), 'ok');
  assert.equal(classifyGapEntry({ at: hoursAgo(72), gaps: 3, uncollected: 3 }, NOW), 'stale');
  assert.equal(classifyGapEntry(undefined, NOW), 'no-data');
  // Entry predating the uncollected field (pre-#823 audit) — must NOT block
  // on the summed gaps number (it counts flaggedMisses, often permanent
  // correct exclusions); unverified until the hourly audit refreshes it.
  assert.equal(classifyGapEntry({ at: hoursAgo(2), gaps: 3 }, NOW), 'no-data');
  assert.equal(classifyGapEntry({ at: 'garbage', gaps: 1, uncollected: 1 }, NOW), 'no-data');
  // freshHours option is respected
  assert.equal(classifyGapEntry({ at: hoursAgo(72), gaps: 3, uncollected: 3 }, NOW, { freshHours: 96 }), 'gap');
});

test('classifyGapEntry: schema safety — corrupt counts and future timestamps are no-data', () => {
  assert.equal(classifyGapEntry({ at: hoursAgo(2), uncollected: -1 }, NOW), 'no-data');
  assert.equal(classifyGapEntry({ at: hoursAgo(2), uncollected: 2.5 }, NOW), 'no-data');
  assert.equal(classifyGapEntry({ at: hoursAgo(2), uncollected: '3' }, NOW), 'no-data');
  // future `at` beyond 1h skew must not read as eternally fresh
  assert.equal(classifyGapEntry({ at: hoursAgo(-6), uncollected: 0 }, NOW), 'no-data');
  // small skew tolerated
  assert.equal(classifyGapEntry({ at: hoursAgo(-0.5), uncollected: 0 }, NOW), 'ok');
});

test('classifyGapEntry: flaggedMisses-only show (Tao of Glass shape) is ok, not gap', () => {
  // missing=[], flaggedMisses=3 → gaps=3 but uncollected=0. Blocking here
  // would fail every issue forever on correct permanent exclusions.
  assert.equal(classifyGapEntry({ at: hoursAgo(2), gaps: 3, uncollected: 0 }, NOW), 'ok');
});

test('completenessFindings: the 2026-08-02 incident shape (Brainiac + Traitors) hard-fails', () => {
  const openingShows = [
    { id: 'brainiac-live-west-end-2026', title: 'Brainiac Live!' },
    { id: 'the-traitors-live-experience-off-west-end-2026', title: 'The Traitors: Live Experience' },
    { id: 'tao-of-glass-west-end-2026', title: 'Tao of Glass' },
  ];
  const checkpoint = {
    'brainiac-live-west-end-2026': { at: hoursAgo(3), gaps: 3, uncollected: 3 },
    'the-traitors-live-experience-off-west-end-2026': { at: hoursAgo(5), gaps: 7, uncollected: 7 },
    'tao-of-glass-west-end-2026': { at: hoursAgo(1), gaps: 3, uncollected: 0 },
  };
  const { hard, soft } = completenessFindings(openingShows, checkpoint, NOW, {
    missingHostsById: { 'brainiac-live-west-end-2026': ['thestage.co.uk', 'timeout.com'] },
  });
  assert.equal(hard.length, 2);
  assert.equal(soft.length, 0);
  assert.match(hard[0], /Brainiac Live!/);
  assert.match(hard[0], /missing 3 review/);
  assert.match(hard[0], /thestage\.co\.uk/);
  assert.match(hard[1], /missing 7 review/);
});

test('completenessFindings: stale and absent entries are soft, never hard', () => {
  const { hard, soft } = completenessFindings(
    [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    { a: { at: hoursAgo(100), gaps: 5 } }, // stale, even with gaps recorded
    NOW
  );
  assert.equal(hard.length, 0);
  assert.equal(soft.length, 2);
  assert.match(soft[0], /unverified/);
  assert.match(soft[1], /no usable gap audit entry/);
});

// ── gapDisclosureDecisions: report the gap, NEVER drop the opening ───────────
// Owner decision 2026-08-09, after the swap these functions replace silently
// deleted three openings from the 2026-08-03 issue (The Pass, Disruption, The
// Comedy About Spies) — two of them over gaps that did not exist. "Include ALL
// shows that opened that week AND collect all reviews. It is not one or the
// other."

test('gapDisclosureDecisions: the 2026-08-02 incident shape keeps every show', () => {
  const openingShows = [
    { id: 'brainiac-live-west-end-2026', title: 'Brainiac Live!' },
    { id: 'the-traitors-live-experience-off-west-end-2026', title: 'The Traitors: Live Experience' },
    { id: 'tao-of-glass-west-end-2026', title: 'Tao of Glass' },
  ];
  const checkpoint = {
    'brainiac-live-west-end-2026': { at: hoursAgo(3), gaps: 3, uncollected: 3 },
    'the-traitors-live-experience-off-west-end-2026': { at: hoursAgo(5), gaps: 7, uncollected: 7 },
    'tao-of-glass-west-end-2026': { at: hoursAgo(1), gaps: 3, uncollected: 0 }, // clean (flaggedMisses only)
  };
  const { gapped, notes } = gapDisclosureDecisions(openingShows, checkpoint, NOW);
  assert.equal(gapped.length, 2, 'both gapped shows reported');
  assert.deepEqual(
    gapped.map((g) => g.id).sort(),
    ['brainiac-live-west-end-2026', 'the-traitors-live-experience-off-west-end-2026'],
  );
  assert.equal(notes.length, 2);
  for (const n of notes) assert.match(n, /INCLUDED WITH GAP/);
  // The old behaviour is now impossible to express: there is no swap channel.
  assert.equal(openingsPreserved(openingShows, openingShows).ok, true);
});

test('gapDisclosureDecisions: a clean show produces nothing at all', () => {
  const openingShows = [{ id: 'clean', title: 'Clean Show' }];
  const { gapped, notes } = gapDisclosureDecisions(
    openingShows, { clean: { at: hoursAgo(1), gaps: 0, uncollected: 0 } }, NOW,
  );
  assert.equal(gapped.length, 0);
  assert.equal(notes.length, 0);
});

test('gapDisclosureDecisions: allowGaps/acked only mark the gap known — the show ships either way', () => {
  const openingShows = [{ id: 'g', title: 'Gapped' }];
  const checkpoint = { g: { at: hoursAgo(1), gaps: 1, uncollected: 1 } };
  const plain = gapDisclosureDecisions(openingShows, checkpoint, NOW);
  const allowed = gapDisclosureDecisions(openingShows, checkpoint, NOW, { allowGaps: true });
  const acked = gapDisclosureDecisions(openingShows, checkpoint, NOW, { ackedShowIds: new Set(['g']) });
  for (const r of [plain, allowed, acked]) {
    assert.equal(r.gapped.length, 1, 'the gap is always reported');
    assert.equal(r.gapped[0].id, 'g');
  }
  assert.equal(plain.gapped[0].acked, false);
  assert.equal(allowed.gapped[0].acked, true);
  assert.equal(acked.gapped[0].acked, true);
  assert.match(acked.notes[0], /already acknowledged/i);
});

test('gapDisclosureDecisions: EVERY show gapped still yields no removal — the 2026-08-03 shape', () => {
  // The real failure: when every opening is gapped there is no clean swap
  // target, and the old code excluded them anyway wherever a lead override
  // existed. The WE issue rendered with no openings section at all.
  const openingShows = [
    { id: 'the-pass-off-broadway-2026', title: 'The Pass', category: 'off-broadway' },
    { id: 'disruption-off-broadway-2026', title: 'Disruption', category: 'off-broadway' },
    { id: 'the-comedy-about-spies-west-end-2026', title: 'The Comedy About Spies', category: 'west-end' },
  ];
  const checkpoint = Object.fromEntries(
    openingShows.map((s) => [s.id, { at: hoursAgo(2), gaps: 2, uncollected: 2 }]),
  );
  const { gapped } = gapDisclosureDecisions(openingShows, checkpoint, NOW);
  assert.equal(gapped.length, 3, 'all three reported');
  assert.equal(
    openingsPreserved(openingShows, openingShows).droppedIds.length, 0,
    'and all three still ship',
  );
});

test('gapDisclosureDecisions: the return shape has no channel that could remove a show', () => {
  // Structural guard. If someone re-adds a `swaps`/`exclude`/`drop` key, this
  // fails — the mechanism cannot come back by accident.
  const r = gapDisclosureDecisions(
    [{ id: 'g', title: 'G' }], { g: { at: hoursAgo(1), gaps: 1, uncollected: 1 } }, NOW,
  );
  assert.deepEqual(Object.keys(r).sort(), ['gapped', 'notes']);
  for (const banned of ['swaps', 'exclude', 'excludeIds', 'drop', 'dropped', 'removed']) {
    assert.ok(!(banned in r), `"${banned}" must not exist — this function may not remove an opening`);
  }
});

// ── openingsPreserved: the no-drop invariant itself ──────────────────────────

test('openingsPreserved: identical sets pass', () => {
  const shows = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(openingsPreserved(shows, shows), { ok: true, droppedIds: [], addedIds: [] });
});

test('openingsPreserved: a dropped opening is caught and named', () => {
  const before = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const after = [{ id: 'a' }, { id: 'c' }];
  const r = openingsPreserved(before, after);
  assert.equal(r.ok, false);
  assert.deepEqual(r.droppedIds, ['b']);
});

test('openingsPreserved: reordering is NOT a drop', () => {
  const before = [{ id: 'a' }, { id: 'b' }];
  const after = [{ id: 'b' }, { id: 'a' }];
  assert.equal(openingsPreserved(before, after).ok, true);
});

test('openingsPreserved: returns a verdict, never throws — a throw would kill the send', () => {
  // House rule (scripts/lib/coverage-gate.js): a gate that cannot reach a
  // confident answer returns the permissive one. pre-send-check.mjs logs
  // ::error:: on a violation; it must not abort the newsletter.
  for (const args of [[null, null], [undefined, [{ id: 'a' }]], [[{ id: 'a' }], null], [[null, {}], [{}]]]) {
    assert.doesNotThrow(() => openingsPreserved(...args));
  }
});
