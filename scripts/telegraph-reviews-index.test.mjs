/**
 * Telegraph reviews-index parser tests (task #720).
 *
 * Fixture is a real capture of https://www.telegraph.co.uk/theatre/reviews/
 * (2026-08-02), trimmed to its <article> cards with inline <svg>/<picture>
 * stripped. It contains the Tao of Glass review whose editorial headline
 * ("This love letter to Philip Glass is full of wonder") and editorial slug
 * (/music/classical-music/this-love-letter-to-philip-glass/) made it invisible
 * to every title-anchored discovery arm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const {
  parseTelegraphReviewCards,
  matchTelegraphCards,
  discoverTelegraphReviewUrls,
  containsPhrase,
  isCardWithinRun,
  INDEX_URL,
  _resetTelegraphIndexCache,
} = require(path.join(repoRoot, 'scripts/lib/telegraph-reviews-index.js'));

// Show records as getShowInfo() shapes them. Real dates matter: the
// production-window gate rejects cards published outside the run.
const TAO = {
  venue: 'Sadler\u2019s Wells', openingDate: '2026-07-30', closingDate: null,
  previewsStartDate: '2026-07-29', cast: [], creativeNames: ['Phelim McDermott'],
  leadActor: 'Phelim McDermott',
};
// Real record for trainspotting-the-musical-west-end-2026 — the card is dated
// 2026-07-22, inside this run.
const TRAINSPOTTING = {
  venue: 'TBA', openingDate: '2026-07-22', closingDate: '2026-09-05',
  previewsStartDate: '2026-07-15', cast: [], creativeNames: [], leadActor: null,
};

const FIXTURE = fs.readFileSync(
  path.join(repoRoot, 'tests/fixtures/telegraph-theatre-reviews-index.html'),
  'utf8'
);

const TAO_URL = 'https://www.telegraph.co.uk/music/classical-music/this-love-letter-to-philip-glass/';

test('parses every review card with url, headline, standfirst, rating, byline and date', () => {
  const cards = parseTelegraphReviewCards(FIXTURE);
  assert.ok(cards.length >= 20, `expected 20+ cards, got ${cards.length}`);

  const tao = cards.find(c => c.url === TAO_URL);
  assert.ok(tao, 'Tao of Glass card not parsed');
  assert.equal(tao.headline, 'This love letter to Philip Glass is full of wonder');
  assert.match(tao.standfirst, /Tao of Glass/);
  assert.equal(tao.rating, '3/5');
  assert.equal(tao.criticName, 'Fiona Mountford');
  assert.equal(tao.publishDate, '2026-07-31T17:09:56.354+01:00');

  // Every parsed URL must be an absolute telegraph.co.uk article URL.
  for (const c of cards) {
    assert.match(c.url, /^https:\/\/www\.telegraph\.co\.uk\/.+/, `bad url: ${c.url}`);
  }
});

test('matches a show whose title appears ONLY in the standfirst (the #720 case)', () => {
  const cards = parseTelegraphReviewCards(FIXTURE);
  const matched = matchTelegraphCards(cards, 'Tao of Glass', TAO);
  assert.deepEqual(matched.map(c => c.url), [TAO_URL]);
});

test('matches a show whose title appears in the URL slug too', () => {
  const cards = parseTelegraphReviewCards(FIXTURE);
  const urls = matchTelegraphCards(cards, 'Trainspotting', TRAINSPOTTING).map(c => c.url);
  assert.deepEqual(urls, ['https://www.telegraph.co.uk/theatre/what-to-see/muddled-trainspotting-musical-review/']);
});

test('returns nothing for a show the Telegraph did not review on this page', () => {
  const cards = parseTelegraphReviewCards(FIXTURE);
  // Guards the real failure mode: every telegraph.co.uk page carries a
  // "more from Theatre" rail naming other shows, so a matcher that looked at
  // page-level text instead of per-card text would attach every review to
  // every show.
  for (const title of ['Hamilton', 'Wicked', 'Oh Mary!']) {
    assert.deepEqual(matchTelegraphCards(cards, title, TAO).map(c => c.url), [], `false positive for ${title}`);
  }
});

test('rejects the one-word / substring false positives found in the live corpus', () => {
  // Every one of these attached a WRONG Telegraph review before the ship-check
  // fix: "Hair"->Krapp's Last Tape, "Sting"->War Horse, "Local"->Beetlejuice,
  // "Wonder"->"...is full of wonder" (Tao of Glass), "Tru"->"the truth",
  // "The Bridge"->the Bridge Theatre in another show's slug.
  const cards = parseTelegraphReviewCards(FIXTURE);
  const bare = { venue: null, openingDate: '2026-07-01', closingDate: null,
    previewsStartDate: null, cast: [], creativeNames: [], leadActor: null };
  for (const title of ['Hair', 'Plenty', 'Sting', 'Local', 'Wonder', 'Tru', 'The Bridge']) {
    assert.deepEqual(
      matchTelegraphCards(cards, title, bare).map(c => c.url), [],
      `one-word false positive survived for ${title}`
    );
  }
});

test('a one-word title in the SLUG is accepted; body-text-only needs showInfo', () => {
  const cards = parseTelegraphReviewCards(FIXTURE);
  // "equus-review-menier-chocolate-factory" — the Telegraph's own slug names the
  // show, which is proof enough even with no show metadata to gate on.
  assert.deepEqual(
    matchTelegraphCards(cards, 'Equus').map(c => c.url),
    ['https://www.telegraph.co.uk/theatre/what-to-see/equus-review-menier-chocolate-factory/']
  );
  // "Wonder" appears only in a headline ("...is full of wonder"), never a slug.
  // With no showInfo there is no disambiguator, so it fails closed.
  assert.deepEqual(matchTelegraphCards(cards, 'Wonder').map(c => c.url), []);
});

test('containsPhrase matches whole token sequences, not substrings', () => {
  assert.equal(containsPhrase('the truth play apollo', 'tru'), false);
  assert.equal(containsPhrase('the truth play apollo', 'the truth'), true);
  assert.equal(containsPhrase('midsummer nights dream', 'nights'), true);
});

test('production-window gate keeps a 2026 review off a long-closed same-title production', () => {
  const card = { url: 'https://www.telegraph.co.uk/x/', publishDate: '2026-07-31T17:09:56+01:00' };
  const closed1993 = { openingDate: '1993-11-21', closingDate: '1994-03-01' };
  const running = { openingDate: '2026-07-14', closingDate: null };
  assert.equal(isCardWithinRun(card, closed1993), false);
  assert.equal(isCardWithinRun(card, running), true);
  // Fails open on missing data rather than under-collecting.
  assert.equal(isCardWithinRun({ url: 'x' }, closed1993), true);
  assert.equal(isCardWithinRun(card, null), true);
});

test('multi-match is treated as ambiguous and returns nothing', () => {
  const cards = [
    { url: 'https://www.telegraph.co.uk/a-review/', headline: 'Cherry Orchard one', standfirst: '', publishDate: null },
    { url: 'https://www.telegraph.co.uk/b-review/', headline: 'Cherry Orchard two', standfirst: '', publishDate: null },
  ];
  assert.deepEqual(matchTelegraphCards(cards, 'Cherry Orchard'), []);
});

test('handles empty / non-string html without throwing', () => {
  assert.deepEqual(parseTelegraphReviewCards(''), []);
  assert.deepEqual(parseTelegraphReviewCards(null), []);
  assert.deepEqual(parseTelegraphReviewCards(undefined), []);
  assert.deepEqual(matchTelegraphCards(null, 'Tao of Glass'), []);
});

test('discoverTelegraphReviewUrls fetches the index and returns matching urls', async () => {
  _resetTelegraphIndexCache();
  let requested = null;
  const urls = await discoverTelegraphReviewUrls('Tao of Glass', async (u) => {
    requested = u;
    return FIXTURE;
  }, () => {}, TAO);
  assert.equal(requested, INDEX_URL);
  assert.deepEqual(urls, [TAO_URL]);
});

test('the index page is fetched once per cycle, not once per show', async () => {
  _resetTelegraphIndexCache();
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return FIXTURE; };
  await discoverTelegraphReviewUrls('Tao of Glass', fetchImpl, () => {}, TAO);
  await discoverTelegraphReviewUrls('Trainspotting', fetchImpl, () => {}, TRAINSPOTTING);
  await discoverTelegraphReviewUrls('Hamilton', fetchImpl, () => {}, TAO);
  assert.equal(fetches, 1, 'index should be cached across shows in one process');
});

test('a partially-parsed index warns instead of looking like a quiet week', async () => {
  _resetTelegraphIndexCache();
  const warnings = [];
  const oneCard = FIXTURE.slice(0, FIXTURE.indexOf('</article>') + 10);
  await discoverTelegraphReviewUrls('Tao of Glass', async () => oneCard, (m) => warnings.push(m), TAO);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /parsed only \d+ usable cards/);
});

test('discoverTelegraphReviewUrls warns loudly (not silently) when the page yields 0 cards', async () => {
  const warnings = [];
  _resetTelegraphIndexCache();
  const urls = await discoverTelegraphReviewUrls(
    'Tao of Glass',
    async () => '<html><body>redesigned, no article cards</body></html>',
    (msg) => warnings.push(msg)
  );
  assert.deepEqual(urls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /0 cards/);
});
