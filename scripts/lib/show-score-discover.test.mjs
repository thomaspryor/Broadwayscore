import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { showScoreUrlForShow } = require('./show-score-discover.js');

// BRO-3416. Show Score keeps ONE page per title — the current or most recent
// production — so when two same-title shows slug to the same URL, at most one
// of them is that page's actual subject. she-loves-me-1994 and she-loves-me-2016
// both pointed at /broadway-shows/she-loves-me (the 2016 Roundabout revival);
// every show-score pass ingested 2016 notices into the 1993-94 entry, leaving
// 21 of that directory's 22 review files belonging to the wrong production.
//
// Deleting the wrong show's curated entry is the established remedy
// (scrape-show-score-audience.js:802 deletes a duplicate outright) but does not
// stick on its own: deletion falls through to slug construction here, which
// rebuilds the identical URL. These tests lock the construction gate that makes
// the deletion durable.

const SLM_2016 = 'https://www.show-score.com/broadway-shows/she-loves-me';

const show1994 = { id: 'she-loves-me-1994', title: 'She Loves Me', category: 'broadway' };
const show2016 = { id: 'she-loves-me-2016', title: 'She Loves Me', category: 'broadway' };

test('curated entry is returned verbatim, even when another show shares the URL', () => {
  // Only CONSTRUCTED urls are gated. An operator who deliberately points two
  // shows at one page keeps that decision.
  const map = { 'she-loves-me-1994': SLM_2016, 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show1994, map), SLM_2016);
});

test('constructed URL is refused when another show already owns it', () => {
  // The post-fix state: she-loves-me-1994's entry has been removed, so its URL
  // would be constructed — and it collides with the 2016 entry.
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show1994, map), null);
});

test('constructed URL is returned when nothing else claims it', () => {
  const map = { 'some-other-show-2020': 'https://www.show-score.com/broadway-shows/something-else' };
  assert.equal(showScoreUrlForShow(show2016, map), SLM_2016);
});

test('a show does not block its own constructed URL', () => {
  // Self-collision must not null out the result.
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show2016, map), SLM_2016);
});

test('ownership comparison ignores a trailing slash and case', () => {
  const map = { 'she-loves-me-2016': 'HTTPS://WWW.Show-Score.com/broadway-shows/She-Loves-Me/' };
  assert.equal(showScoreUrlForShow(show1994, map), null);
});

test('off-Broadway shows use the off-broadway-shows section', () => {
  const ob = { id: 'x-off-broadway-2026', title: 'Example Show', category: 'off-broadway' };
  assert.equal(showScoreUrlForShow(ob, {}), 'https://www.show-score.com/off-broadway-shows/example-show');
});

test('an off-Broadway constructed URL does not collide with the Broadway section', () => {
  // Different sections mean different pages — same slug must NOT be treated as
  // the same URL.
  const ob = { id: 'she-loves-me-off-broadway-2026', title: 'She Loves Me', category: 'off-broadway' };
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(ob, map), 'https://www.show-score.com/off-broadway-shows/she-loves-me');
});

test('non-string map values are skipped rather than throwing', () => {
  const map = { 'busted-entry': null, 'another': undefined, 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show1994, map), null);
});

test('no map at all still constructs (callers may pass nothing)', () => {
  assert.equal(showScoreUrlForShow(show2016, null), SLM_2016);
  assert.equal(showScoreUrlForShow(show2016, undefined), SLM_2016);
});

test('missing show or title yields null', () => {
  assert.equal(showScoreUrlForShow(null, {}), null);
  assert.equal(showScoreUrlForShow({ id: 'x' }, {}), null);
});

test('diacritics are folded before slugging (Les Misérables)', () => {
  // Regression guard on the pre-existing behaviour the fix must not disturb:
  // without folding, é becomes a separator and the slug 404s (task #648).
  const show = { id: 'les-miserables-2014', title: 'Les Misérables', category: 'broadway' };
  assert.equal(showScoreUrlForShow(show, {}), 'https://www.show-score.com/broadway-shows/les-miserables');
});

test('London and regional shows never get a constructed NYC url', () => {
  // space-dogs-off-west-end-2026 slugged to the NYC /broadway-shows/space-dogs
  // page and pulled MCC's 2022 Off-Broadway notices in as current-run misses.
  for (const category of ['west-end', 'off-west-end', 'regional', '', undefined]) {
    const show = { id: `space-dogs-${category}`, title: 'Space Dogs', category };
    assert.equal(showScoreUrlForShow(show, {}), null, `category=${category}`);
  }
});

test('a curated London entry is still returned for a West End show', () => {
  const url = 'https://www.show-score.com/uk/london/west-end-shows/hadestown-west-end';
  const show = { id: 'hadestown-west-end-2024', title: 'Hadestown', category: 'west-end' };
  assert.equal(showScoreUrlForShow(show, { 'hadestown-west-end-2024': url }), url);
});
