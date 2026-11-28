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

test('bylines: particle surnames kept, a following caps heading or ". Next" never joins the name', () => {
  assert.equal(m.nineWrapSectionByline('Reviewed by Anna de Souza Advertisement'), 'Anna de Souza');
  assert.equal(m.nineWrapSectionByline('Reviewed by Ben van der Berg Advertisement'), 'Ben van der Berg');
  assert.equal(m.nineWrapSectionByline('Reviewed by Mary Smith THEATRE Hamlet'), 'Mary Smith');
  assert.equal(m.nineWrapSectionByline('Reviewed by Mary Smith. Next Para'), 'Mary Smith');
  assert.equal(m.nineWrapSectionByline('Reviewed by Jansson J. Antmann Advertisement'), 'Jansson J. Antmann');
});

test('a caps genre word plus stars inside a body is not a heading', () => {
  const t = 'A A A Share MUSIC Band ★★★ body says the ART Gallery rated ★★★★ ok. Reviewed by Al Bo Advertisement DANCE Swan ★★★ b. Reviewed by Cy Do Advertisement';
  assert.deepEqual(m.findNineWrapHeadings(t).map((h) => h.title), ['Band', 'Swan']);
});

test('isolation plan: a Nine wrap verdict naming another item is judged with the Nine detector', async () => {
  const plan = require('../../scripts/lib/multi-show-isolation-plan.js');
  const own = m.isolateMultiShowSection(WRAP_URL, WRAP, 'A Room with a View').text;
  const reason = 'CV-promoted: The scraped content reviews "My Fair Lady"';
  assert.equal(plan.verdictCitesOtherSection(reason, WRAP, own, { url: WRAP_URL }), true);
  assert.equal(plan.needsRefetch({ url: WRAP_URL, wrongShow: true, fullText: own }), true);
});

// BRO-8453: the collector paths must take the section byline too. Each test
// requires the path's real decision function and asserts the SECOND item's critic.
const paths = {
  gap: () => require('../../scripts/lib/gap-acceptance.js'),
  prefetch: () => require('../../scripts/lib/discovery-prefetch.js'),
};
const TWO_ITEM = [
  'A A A Melbourne review wrap Share',
  item('MUSIC', 'Band Name', '★★★★', 'Alex Example', 'First item body with plenty of synthetic words in it to keep it long enough to stand.'),
  item('THEATRE', 'A Room with a View', '★★★½', 'Sam Sample', 'Second item body with plenty of synthetic words in it to keep it long enough to stand.'),
].join(' ');
m.seedShowTitlesForTest({ 'room-view-2026': 'A Room with a View', 'band-name-2026': 'Band Name' });

test('sectionCriticFor: section byline, null for an unsigned item, fallback off-host', () => {
  const iso = m.isolateMultiShowSection(WRAP_URL, TWO_ITEM, 'A Room with a View');
  assert.deepEqual(m.sectionCriticFor(WRAP_URL, iso, 'Alex Example'), { creditsSection: true, criticName: 'Sam Sample' });
  const unsigned = { action: 'isolated', text: 'THEATRE Some Play ★★★ no credit line here' };
  assert.deepEqual(m.sectionCriticFor(WRAP_URL, unsigned, 'Alex Example'), { creditsSection: true, criticName: null });
  assert.deepEqual(m.sectionCriticFor('https://example.com/x', iso, 'Z Z'), { creditsSection: false, criticName: 'Z Z' });
  assert.deepEqual(m.sectionCriticFor(WRAP_URL, { action: 'single-section', text: 'x' }, 'Alex Example'), { creditsSection: false, criticName: 'Alex Example' });
});

test('gap-acceptance cleanCandidateText: second item carries its own critic; identity proof sees it', () => {
  const g = paths.gap();
  const c = g.cleanCandidateText(TWO_ITEM, { url: WRAP_URL, showId: 'room-view-2026' });
  assert.equal(c.refused, false);
  assert.equal(c.creditsSection, true);
  assert.equal(c.criticName, 'Sam Sample');
  assert.equal(g.bylineForCleaned(c, 'Alex Example'), 'Sam Sample');
  const unsigned = { creditsSection: true, criticName: null };
  assert.equal(g.bylineForCleaned(unsigned, 'Alex Example'), null);
  assert.equal(g.bylineForCleaned({ creditsSection: false }, 'Alex Example'), 'Alex Example');
});

test('discovery-prefetch: isolated second item is credited to its section byline, never the page byline', async () => {
  const { prefetchDiscoveredArticle, applyPrefetch } = paths.prefetch();
  const body = TWO_ITEM.replace(/ Reviewed by /g, '. Reviewed by ');
  const html = `<html><head><title>Review wrap</title><script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Alex Example"}}</script></head><body><article><p>${body}</p></article>${' '.repeat(600)}</body></html>`;
  const pre = await prefetchDiscoveredArticle(WRAP_URL, { criticName: 'Alex Example', showId: 'room-view-2026', fetchPageFn: async () => ({ content: html }) });
  assert.equal(pre.criticOverride, true);
  assert.equal(pre.criticName, 'Sam Sample');
  assert.equal(applyPrefetch({ criticName: 'Alex Example', fields: {} }, pre).criticName, 'Sam Sample');
  // an unsigned section is Unknown even though the SERP and the page both name the first critic
  assert.equal(applyPrefetch({ criticName: 'Alex Example', fields: {} }, { criticOverride: true, criticName: null }).criticName, 'Unknown');
  assert.equal(applyPrefetch({ criticName: 'Alex Example', fields: {} }, { criticName: null }).criticName, 'Alex Example');
});

test('collector write step: applySectionCritic credits the item, keeps manual/locked credits', () => {
  const iso = m.isolateMultiShowSection(WRAP_URL, TWO_ITEM, 'A Room with a View');
  const d = { criticName: 'Alex Example' };
  const r = m.applySectionCritic(d, WRAP_URL, iso);
  assert.deepEqual([r.creditsSection, r.changed, d.criticName, d._priorCriticName], [true, true, 'Sam Sample', 'Alex Example']);
  const manual = { criticName: 'Alex Example', criticNameManual: true };
  assert.deepEqual(m.applySectionCritic(manual, WRAP_URL, iso), { creditsSection: true, changed: false, criticName: 'Alex Example' });
  assert.equal(manual.criticName, 'Alex Example');
  const unsigned = { criticName: 'Alex Example' };
  m.applySectionCritic(unsigned, WRAP_URL, { action: 'isolated', text: 'THEATRE Play ★★★ nothing' });
  assert.equal(unsigned.criticName, 'Unknown');
  const other = { criticName: 'Alex Example' };
  assert.equal(m.applySectionCritic(other, 'https://example.com/x', iso).creditsSection, false);
  assert.equal(other.criticName, 'Alex Example');
});

test('class guard: every page-author overwrite in collect-review-texts is gated on sectionCredited', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  for (const needle of [
    'if (html && !data.criticNameManual && !sectionCredited) {',
    "hcConfirmsByline && !data.criticNameManual && !sectionCredited",
    "html && !data.criticNameManual && !sectionCredited) {",
  ]) assert.ok(src.includes(needle), `missing gate: ${needle}`);
  assert.match(src, /applySectionCritic\(data, data\.url \|\| review\.url, iso\)/);
});
