// BRO-4315: Check 8 title containment matches whole words only.
// normalizeTitle used to strip "A Midsummer Night's Dream" to "dream",
// and a raw substring test then matched it inside "dreamgirls",
// failing validate-data and every rename-show-ids.yml run on 2026-10-29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate, normalizeTitle, isSubtitleVariantOf, checkKnownDuplicates } = require('../../scripts/lib/deduplication.js');
const { tryTbDirectUrl, verifyTbPage } = require('../../scripts/lib/tb-direct-url.js');

test('integral multi-word possessives retain the title before the possessive', () => {
  for (const [title, expected, unrelated] of [
    ["A Midsummer Night's Dream", 'midsummer nights dream', 'Dream'],
    ["No Man's Land", 'no mans land', 'Land'],
    ["Our Country's Good", 'our countrys good', 'Good'],
    ["The Time Traveller's Wife", 'time travellers wife', "The Baker's Wife"],
    ["Smokey Joe's Cafe", 'smokey joes cafe', "Wally's Cafe"],
  ]) {
    assert.equal(normalizeTitle(title), expected);
    assert.equal(isSubtitleVariantOf(title, unrelated), false, `${title} / ${unrelated}`);
    assert.equal(isSubtitleVariantOf(unrelated, title), false, `${unrelated} / ${title}`);
  }
  assert.equal(isSubtitleVariantOf("A Midsummer Night's Dream", "A Midsummer Night's Dream - Unicorn"), true);
  assert.equal(isSubtitleVariantOf("No Man's Land", 'No Man’s Land'), true);
  assert.equal(normalizeTitle('A Midsummer Night’s Dream'), 'midsummer nights dream');
});

test('known author and brand prefixes still normalize to the underlying work', () => {
  for (const [title, expected] of [
    ["Disney's Aladdin", 'aladdin'],
    ["Thornton Wilder's The Emporium", 'emporium'],
    ["Andrew Lloyd Webber's Cats", 'cats'],
    ['Stephen Sondheim’s Old Friends', 'old friends'],
    ["Bob Fosse's Dancin'", 'dancin'],
    ["Anne Washburn's ANON", 'anon'],
    ['August Wilson’s Fences', 'fences'],
  ]) assert.equal(normalizeTitle(title), expected, title);
});

test('same-venue exact-title checks do not collapse Midsummer into Dream', () => {
  const common = { venue: 'Circle in the Square Theatre', openingDate: '2026-09-27', category: 'broadway' };
  const midsummer = { ...common, id: 'midsummer-2026', slug: 'midsummer', title: "A Midsummer Night's Dream" };
  const dream = { ...common, id: 'dream-2026', slug: 'dream', title: 'Dream' };
  assert.equal(checkForDuplicate(midsummer, [dream]).isDuplicate, false);
  assert.equal(checkForDuplicate(dream, [midsummer]).isDuplicate, false);
});

test('known duplicate groups reject partial words in both directions', () => {
  for (const [title, canonical] of [['cabare', 'cabaret'], ['phantom of the oper', 'phantom of the opera'], ['sixteen wounded', 'six']]) {
    assert.equal(checkKnownDuplicates(title, canonical).isDuplicate, false, title);
    assert.equal(checkKnownDuplicates(canonical, title).isDuplicate, false, title);
  }
  assert.equal(checkKnownDuplicates('six the musical', 'six').isDuplicate, true);
  assert.equal(checkKnownDuplicates('sixteen six', 'six').isDuplicate, true);
  assert.equal(checkKnownDuplicates('', 'six').isDuplicate, false);
});

test('shared whole-word helper rejects empty needles and partial words', () => {
  const { containsAsWords } = require('../../scripts/lib/title-containment.js');
  for (const [haystack, needle, expected] of [
    ['', '', false], ['hair', '', false], ['hair', ' ', false],
    ['hairspray', 'hair', false], ['sixteen six', 'six', true],
    ['fun home revival', 'fun home', true], ['hair', 'hair', true],
  ]) assert.equal(containsAsWords(haystack, needle), expected, `${haystack} / ${needle}`);
});

function reviewHtml(title) {
  return `<title>Talkin' Broadway Review: "${title}"</title><p>Reviewed by Howard Miller</p>${'x'.repeat(900)}`;
}

test('TB candidate-page verification requires whole words for full and short titles', () => {
  for (const [showTitle, pageTitle, expected] of [
    ['Hair', 'Hairspray', false], ['Beaches, A New Musical', 'Beacheside', false],
    ['Hair', 'Hair', true], ['Beaches, A New Musical', 'Beaches', true],
    ['', 'Hair', false],
  ]) assert.equal(verifyTbPage(reviewHtml(pageTitle), { showTitle }).ok, expected, `${showTitle} / ${pageTitle}`);
});

test('TB index fallback requires whole words in both title directions', async () => {
  for (const [showTitle, indexTitle, expected] of [
    ['Hair', 'Hairspray', false], ['Hairspray', 'Hair', false],
    ['Oh, Mary!', 'Wholesome', false], ['', 'Hair', false],
    ['Hair', 'Hair', true], ['Beaches, A New Musical', 'Beaches', true],
    ['Beaches', 'Beaches, A New Musical', true],
  ]) {
    const result = await tryTbDirectUrl({
      show: { title: showTitle }, year: 2026, logger: { log() {} },
      fetchPage: async (url) => url.endsWith('/index.html') ? { content: reviewHtml(indexTitle) } : null,
    });
    assert.equal(result.found, expected, `${showTitle} / ${indexTitle}: ${result.reason}`);
    if (expected) assert.equal(result.source, 'direct-url-index-fallback');
  }
});

test('a word inside a longer word is not title containment', () => {
  const r = checkForDuplicate(
    // The real rows from shows.json.
    { id: 'a-midsummer-nights-dream-chichester-festival-regional-2026', slug: 'a-midsummer-nights-dream-chichester-festival-regional-2026', title: "A Midsummer Night's Dream", venue: 'Chichester Festival Theatre, Chichester', openingDate: '2026-09-27', category: 'regional' },
    [{ id: 'dreamgirls-2026', slug: 'dreamgirls', title: 'Dreamgirls', venue: null, openingDate: null, category: 'broadway' }],
  );
  assert.equal(r.isDuplicate, false, r.reason);
});

test('whole-word containment still flags a duplicate', () => {
  const r = checkForDuplicate(
    { id: 'fun-home-revival-2026', slug: 'fun-home-revival', title: 'Fun Home Revival', venue: 'Circle in the Square Theatre', category: 'broadway' },
    [{ id: 'fun-home-2026', slug: 'fun-home', title: 'Fun Home', venue: 'Circle in the Square Theatre', category: 'broadway' }],
  );
  assert.equal(r.isDuplicate, true);
});

// BRO-6547: a bare one-word possessive is part of the title, not an author
// prefix. Each pair below is two different plays that used to share a key.
test('one-word possessives are kept unless a known brand/author', () => {
  for (const [a, b] of [
    ["Hell's Kitchen", 'The Kitchen'],
    ["Marvin's Room", "Veronica's Room"],
    ["A Doll's House", "A Dog's House"],
    ["Sherlock's Last Tape", "Krapp's Last Tape"],
    ["Brooklyn's Bridge", 'The Bridge'],
  ]) {
    assert.notEqual(normalizeTitle(a), normalizeTitle(b), `${a} vs ${b}`);
  }
  for (const [a, b] of [
    ["Disney's Beauty and the Beast", 'Beauty and the Beast'],
    ["Shakespeare's Macbeth", 'Macbeth'],
    ["Thornton Wilder's The Emporium", 'The Emporium'],
  ]) {
    assert.equal(normalizeTitle(a), normalizeTitle(b), `${a} vs ${b}`);
  }
});
