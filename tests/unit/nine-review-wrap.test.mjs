// BRO-8433: Nine Publishing review wraps (The Age / SMH live-reviews pages hold
// several short reviews). Every text path must cut one show's item out, with
// that item's own critic. Fixtures are synthetic: no review text is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = require('../../scripts/lib/multi-show-section-extract.js');

const WRAP_URL = 'https://www.theage.com.au/culture/live-reviews/melbourne-review-wrap-example-20261115-p61zzz.html';

const item = (genre, title, stars, critic, filler) =>
  `${genre} ${title} ${stars} Example Theatre, until December 1 ${filler} Synthetic sentence two about the staging. Reviewed by ${critic} Advertisement`;

const WRAP = [
  'A A A Melbourne review wrap Share',
  item('MUSIC', 'Band Name | The Big Tour', '★★★★★', 'Alex Example', 'The ART of a loud set.'),
  item('MUSICAL THEATRE', 'My Fair Lady', '★★★★', 'Thuy On', 'Synthetic body about the musical.'),
  item('THEATRE', 'A Room with a View', '★★★½', 'Sam Sample', 'Synthetic body about the play.'),
  item('OPERA', 'Watershed: An Opera', '★★★', 'Jo Placeholder', 'Synthetic body about the opera.'),
].join(' ');

test('finds one heading per wrap item, longest genre first, skipping page furniture', () => {
  const heads = m.findNineWrapHeadings(WRAP);
  assert.deepEqual(heads.map((h) => h.title), ['Band Name | The Big Tour', 'My Fair Lady', 'A Room with a View', 'Watershed: An Opera']);
  // "MUSICAL THEATRE" heads the section, not a bare "THEATRE" inside it
  assert.ok(WRAP.slice(heads[1].start).startsWith('MUSICAL THEATRE My Fair Lady'));
});

test('a capitalised genre word in the previous body does not swallow the next heading', () => {
  const heads = m.findNineWrapHeadings(WRAP);
  assert.ok(WRAP.slice(heads[0].start).startsWith('MUSIC Band Name'));
  assert.equal(heads.length, 4);
});

test('isolates the show item with its own byline, and only that item', () => {
  const iso = m.isolateMultiShowSection(WRAP_URL, WRAP, 'A Room with a View');
  assert.equal(iso.action, 'isolated');
  assert.match(iso.text, /^THEATRE A Room with a View ★★★½/);
  assert.match(iso.text, /Reviewed by Sam Sample Advertisement$/);
  assert.equal(iso.text.includes('My Fair Lady'), false);
  assert.equal(iso.text.includes('Watershed'), false);
  assert.equal(m.isolatedSectionByline(WRAP_URL, iso.text), 'Sam Sample');
  // the last item ends at the end of the page
  assert.match(m.isolateMultiShowSection(WRAP_URL, WRAP, 'Watershed: An Opera').text, /Jo Placeholder Advertisement$/);
});

test('a title with "|" still matches its own side only when the whole title is ours', () => {
  assert.equal(m.isolateMultiShowSection(WRAP_URL, WRAP, 'Band Name | The Big Tour').action, 'isolated');
});

test('refuses when the show is not on the wrap (never stores another show\'s item)', () => {
  assert.deepEqual(m.isolateMultiShowSection(WRAP_URL, WRAP, 'Fiddler on the Roof'), { action: 'refuse', text: null });
});

test('a single-review live-reviews page is left whole', () => {
  const single = item('MUSICAL THEATRE', 'Fiddler on the Roof', '★★★★★', 'Thuy On', 'Synthetic body.');
  assert.equal(m.isolateMultiShowSection(WRAP_URL, single, 'Fiddler on the Roof').action, 'single-section');
});

test('Nine pages outside /culture/live-reviews/ and other hosts are not multi-show', () => {
  assert.equal(m.isMultiShowPostUrl('https://www.theage.com.au/culture/theatre/some-feature-20261115-p61zzz.html'), false);
  assert.equal(m.isMultiShowPostUrl('https://www.smh.com.au/culture/live-reviews/x-20261115-p61zzz.html'), true);
  assert.equal(m.isMultiShowPostUrl('https://www.notheage.com.au/culture/live-reviews/x'), false);
  assert.equal(m.isolateMultiShowSection('https://www.guardian.com/x', WRAP, 'My Fair Lady').action, 'not-multi-show');
});

test('class guard: isMultiShowPostUrl agrees with the strategy table, each strategy has a detector', () => {
  for (const st of m.MULTI_SHOW_POST_STRATEGIES) assert.equal(typeof st.findHeadings, 'function', st.name);
  assert.equal(m.multiShowStrategyFor(WRAP_URL).name, 'nine-review-wrap');
  assert.equal(m.multiShowStrategyFor('https://www.interestedbystander.com/2024/04/x/').name, 'interestedbystander');
  assert.deepEqual(m.findHeadingsForUrl('https://example.com/x', WRAP), []);
});

test('isolateForIngest: section critic replaces the page byline; refusal and pass-through', () => {
  const cut = m.isolateForIngest({ url: WRAP_URL, text: WRAP, showTitle: 'My Fair Lady', criticName: 'Alex Example', ownerShowIds: () => [] });
  assert.equal(cut.refuse, false);
  assert.equal(cut.isolated, true);
  assert.equal(cut.criticName, 'Thuy On');
  assert.deepEqual(cut.writeFields, {});
  assert.deepEqual(m.isolateForIngest({ url: WRAP_URL, text: WRAP, showTitle: 'Nope Show', criticName: null, ownerShowIds: () => [] }), { refuse: true });
  const plain = m.isolateForIngest({ url: 'https://example.com/r', text: 'body', showTitle: 'My Fair Lady', criticName: 'X Y', ownerShowIds: () => { throw new Error('not called'); } });
  assert.deepEqual(plain, { refuse: false, isolated: false, text: 'body', criticName: 'X Y', writeFields: {} });
});

test('all-caps show titles are headings; genre-only runs are not', () => {
  const t = [item('MUSICAL THEATRE', 'SIX', '★★★★', 'Ann Example', 'Synthetic body.'), item('THEATRE', 'RENT', '★★★', 'Bo Example', 'Synthetic.'), 'THEATRE OPERA ★★'].join(' ');
  assert.deepEqual(m.findNineWrapHeadings(t).map((h) => h.title), ['SIX', 'RENT']);
  assert.equal(m.isolateMultiShowSection(WRAP_URL, t, 'SIX').action, 'isolated');
});

test('a wrap item with no byline is Unknown, never the page (first item) byline', () => {
  const t = [item('MUSIC', 'Band Name', '★★★', 'Alex Example', 'Body.'), 'THEATRE Some Play ★★★ Venue, until May 1 Synthetic body with no credit line.'].join(' ');
  const cut = m.isolateForIngest({ url: WRAP_URL, text: t, showTitle: 'Some Play', criticName: 'Alex Example', ownerShowIds: () => [] });
  assert.equal(cut.isolated, true);
  assert.equal(cut.criticName, null);
});
