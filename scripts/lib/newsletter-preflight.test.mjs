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
