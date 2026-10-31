// TESTS-VS-DERIVED-DATA-EXEMPT: structural sibling-pair checks; dates are read from shows.json itself, so no factual claim is pinned
/**
 * BRO-2350: confirms the sibling-misfile guard in extract-show-score-reviews.js
 * (BRO-363) rejects a WHOLE show-score.json entry exactly when >=50% (min 3) of
 * its critic tiles date-match ONE sibling's opening, and nothing else.
 * Drives the real extractShowData() with synthetic Show Score pages built from
 * real sibling pairs in data/shows.json. The 154-entry mass rejection seen at
 * full-corpus scale was contaminated archives (cleaned by BRO-2121); this
 * pins that the rejection rule itself is intended and has no false positives
 * for pages that match their own opening.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { extractShowData } = require('../../scripts/extract-show-score-reviews.js');

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
const list = raw.shows || raw;
const shows = Array.isArray(list) ? list : Object.values(list);
const byId = new Map(shows.map(s => [s.id, s]));
const open = id => byId.get(id).openingDate;

// "2022-12-04" -> "Dec 4, 2022" style tile date
const fmt = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function page(dates, slug) {
  const tiles = dates.map((d, i) => `
    <div class="review-tile-v2 -critic">
      <div class="user-avatar-v2"><img alt="Outlet ${i}"></div>
      <span class="review-tile-v2__date">${d}</span>
      <div class="review-tile-v2__authors"><a>Critic ${i}</a></div>
      <div class="review-tile-v2__review"><p>Words ${i}</p><a href="https://example.com/review-${slug}-${i}">Read more</a></div>
    </div>`).join('');
  return `<html><head><title>Show Score</title>
    <script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":88,"reviewCount":500}}</script>
    </head><body><h2>Critic Reviews (${dates.length})</h2>${tiles}</body></html>`;
}
const quiet = fn => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };
const run = (id, dates) => quiet(() => extractShowData(page(dates, id), id, null));

const PAIRS = [
  ['a-christmas-carol-1994', 'a-christmas-carol-2022'],
  ['oh-mary-off-broadway-2024', 'oh-mary-2024'],
];

for (const [own, sibling] of PAIRS) {
  test(`${own}: all tiles dated at ${sibling}'s opening -> entire entry rejected`, () => {
    const r = run(own, Array(6).fill(fmt(open(sibling))));
    assert.equal(r._rejectAll, true);
    assert.equal(r._siblingMisfile.targetId, sibling);
    assert.deepEqual(r.criticReviews, []);
    assert.equal(r.rejectedCriticUrls.length, 6);
    assert.match(r._rejectionReason, /^sibling-misfile: 6\/6/);
  });

  test(`${own}: exactly 50% sibling-dated (3 of 6) -> rejected (boundary)`, () => {
    const r = run(own, [...Array(3).fill(fmt(open(sibling))), ...Array(3).fill(fmt(open(own)))]);
    assert.equal(r._rejectAll, true);
  });

  test(`${own}: under 50% sibling-dated (2 of 6) -> kept`, () => {
    const r = run(own, [...Array(2).fill(fmt(open(sibling))), ...Array(4).fill(fmt(open(own)))]);
    assert.notEqual(r._rejectAll, true);
    assert.equal(r.criticReviews.length, 6);
  });

  test(`${sibling}: page matching its OWN opening is never rejected`, () => {
    const r = run(sibling, Array(6).fill(fmt(open(sibling))));
    assert.notEqual(r._rejectAll, true);
    assert.equal(r.criticReviews.length, 6);
    assert.equal(r.audienceScore, 88);
  });
}

test('fewer than 3 sibling-dated tiles (min-count floor) -> kept even at 100%', () => {
  const [own, sibling] = PAIRS[0];
  const r = run(own, Array(2).fill(fmt(open(sibling))));
  assert.notEqual(r._rejectAll, true);
  assert.equal(r.criticReviews.length, 2);
});
