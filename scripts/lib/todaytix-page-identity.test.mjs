// Tests for TodayTix page identity (BRO-4851). The fixture mirrors the real
// __NEXT_DATA__ shape of todaytix.com/london/shows/45696-the-shitheads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractTodaytixPageIdentity, todaytixPageMatchesShow, cleanTodaytixAbout } = require('./todaytix-page-identity.js');

const page = (product, extra = {}) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { product, ...extra } },
})}</script></html>`;
const SHITHEADS = { id: 45696, displayName: 'The Shitheads', venue: { name: 'Royal Court' }, startingDate: '2026-02-06', closingDate: '2026-03-14' };
const show = { id: 'the-shitheads-west-end-2026', title: 'The Shitheads', venue: 'Royal Court', previewsStartDate: '2026-02-13', closingDate: '2026-03-14' };

test('reads the page\'s own product', () => {
  assert.deepEqual(extractTodaytixPageIdentity(page(SHITHEADS)),
    { id: '45696', title: 'The Shitheads', venue: 'Royal Court', start: '2026-02-06', end: '2026-03-14', about: '' });
  assert.equal(extractTodaytixPageIdentity('<html>no data</html>'), null);
  assert.equal(extractTodaytixPageIdentity('<script id="__NEXT_DATA__">{bad json</script>'), null);
});

test('matches only on id + title + venue + overlapping dates', () => {
  const id = extractTodaytixPageIdentity(page(SHITHEADS));
  assert.equal(todaytixPageMatchesShow(id, show, 45696), true);
  assert.equal(todaytixPageMatchesShow(id, show, 11111), false); // asked for another id
  assert.equal(todaytixPageMatchesShow(id, { ...show, title: 'Shitheads II' }, 45696), false);
  assert.equal(todaytixPageMatchesShow(id, { ...show, venue: 'Young Vic' }, 45696), false);
  assert.equal(todaytixPageMatchesShow(id, { ...show, previewsStartDate: '2027-01-10', closingDate: '2027-02-01' }, 45696), false);
});

test('a recycled id whose page lists our show only in a related carousel does not match', () => {
  const recycled = page(
    { id: 45696, displayName: 'Radiolab Live', venue: { name: 'Southbank Centre' } },
    { relatedProducts: [SHITHEADS] },
  );
  assert.equal(todaytixPageMatchesShow(extractTodaytixPageIdentity(recycled), show, 45696), false);
});

// Real product.about shape (45696). Run 37818726628 saved scraped paragraphs
// (quotes, age notes, cast lists) as synopses; only story sentences may pass.
test('cleanTodaytixAbout keeps story sentences and drops pitch, tickets, notes and lists', () => {
  const about = 'See the world premiere of *The Shitheads*, a captivating new black comedy at the Royal Court Theatre. Book *The Shitheads* tickets on TodayTix.   *The Shitheads* is a play that is set thousands of years ago among some of the earliest inhabitants of Britain. The harmony of their cave life is shattered when strangers arrive. Age guidance: 14+. Running time: 1 hour 40 minutes. ★★★★★ "Brilliant" – The Guardian.';
  assert.equal(cleanTodaytixAbout(about),
    'The Shitheads is a play that is set thousands of years ago among some of the earliest inhabitants of Britain. The harmony of their cave life is shattered when strangers arrive.');
});

test('cleanTodaytixAbout returns empty when nothing reads as plot (caller falls back to the verifier)', () => {
  assert.equal(cleanTodaytixAbout('The talented cast bringing this story to life are A, B and C. Book tickets now.'), '');
  assert.equal(cleanTodaytixAbout('This heartfelt drama is best for children ages 12 and above.'), '');
  assert.equal(cleanTodaytixAbout(''), '');
});

test('markdown links, headings and HTML are stripped; output ends at a sentence', () => {
  const out = cleanTodaytixAbout('## About\n<p>A family drama [set in](https://x) 1970s Glasgow follows three sisters.</p> ' + 'It explores grief. '.repeat(80));
  assert.ok(out.startsWith('About A family drama set in 1970s Glasgow follows three sisters.') || out.startsWith('A family drama set in 1970s Glasgow follows three sisters.'));
  assert.match(out, /[.!?]$/);
  assert.ok(out.length <= 700);
});

// Run 37828755764: curly apostrophes let "Don’t miss" openers through, a
// pull quote rode along (Unicorn) and a stray opening quote led (Brace Brace).
test('curly-quote openers, pull quotes and stray leading quotes are removed', () => {
  const unicorn = 'Don\u2019t miss the world premiere of Unicorn, the funny and provocative new play by Mike Bartlett. \u201CMike Bartlett\u2019s Unicorn is that rare beast, very, very funny,\u201D Nicola Walker said. The play follows a married couple whose life is upended when a younger woman enters it.';
  assert.equal(cleanTodaytixAbout(unicorn), 'The play follows a married couple whose life is upended when a younger woman enters it.');
  assert.equal(cleanTodaytixAbout('" Brace Brace is a play that explores how catastrophe impacts survivors.'), 'Brace Brace is a play that explores how catastrophe impacts survivors.');
});
