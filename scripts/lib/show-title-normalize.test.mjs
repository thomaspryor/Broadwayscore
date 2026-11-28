import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeShowTitle, buildVenueVocabulary, applyNormalizedTitle, undoNormalizedTitle, healShowTitles } = require('./show-title-normalize.js');

test('applies the venue strip alone', () => {
  const r = normalizeShowTitle({
    id: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026',
    title: 'The Cherry Orchard (Park Avenue Armory)',
    venue: 'Park Avenue Armory',
  });
  assert.equal(r.title, 'The Cherry Orchard');
  assert.equal(r.changed, true);
  assert.deepEqual(r.steps.map(s => s.kind), ['venue-suffix']);
});

test('a shouted title is flagged, never guess-rewritten (BRO-3920)', () => {
  const r = normalizeShowTitle({ id: 'america-who-hurt-you', title: 'AMERICA, WHO HURT YOU?' });
  assert.equal(r.title, 'AMERICA, WHO HURT YOU?', 'must not invent a casing');
  assert.equal(r.changed, false);
  assert.equal(r.manualReview, true);
  assert.deepEqual(r.steps, []);
});

test('ORDER: stripping the venue exposes a shouted title underneath', () => {
  // "Theaters" inside the parenthetical supplies the only lowercase letters
  // in the string, so the detector sees a mixed-case title and does not
  // fire. Strip the venue first and "SO MUCH TO SAY ABOUT NOTHING." is
  // plainly shouted — flagged, not rewritten.
  const r = normalizeShowTitle({
    id: 'so-much-to-say-about-nothing-59e59-theaters-off-broadway-2026',
    title: 'SO MUCH TO SAY ABOUT NOTHING. (59E59 Theaters)',
    venue: '59E59 Theaters, Theater C',
  });
  assert.equal(r.title, 'SO MUCH TO SAY ABOUT NOTHING.');
  assert.equal(r.manualReview, true);
  assert.deepEqual(r.steps.map(s => s.kind), ['venue-suffix']);
});

test('the reverse order would never detect the shout, which is why the order is fixed', () => {
  const { isShoutedTitle } = require('./title-display-case.js');
  assert.equal(
    isShoutedTitle('SO MUCH TO SAY ABOUT NOTHING. (59E59 Theaters)'),
    false,
    'detection first does nothing — this pins WHY venue-strip runs first',
  );
});

test('a clean title is returned unchanged with no steps', () => {
  const r = normalizeShowTitle({ id: 'x', title: 'Death of a Salesman', venue: 'Hudson Theatre' });
  assert.equal(r.title, 'Death of a Salesman');
  assert.equal(r.changed, false);
  assert.deepEqual(r.steps, []);
});

test('manual-review titles are flagged and NOT guessed at', () => {
  const r = normalizeShowTitle({
    id: 'mas-sabe-el-saulo-por-viejo-off-broadway-2025',
    title: 'MÁS SABE EL SAULO POR VIEJO...',
  });
  assert.equal(r.manualReview, true);
  assert.equal(r.changed, false, 'must not invent Spanish casing');
  assert.equal(r.title, 'MÁS SABE EL SAULO POR VIEJO...');
});

test('the corpus vocabulary oracle reaches rows whose own venue disagrees', () => {
  const vocab = buildVenueVocabulary([{ venue: 'Soho Playhouse' }, { venue: 'Hudson Theatre' }]);
  const r = normalizeShowTitle(
    { id: 'x', title: 'A Play (Soho Playhouse)', venue: 'Somewhere Else Entirely' },
    { venueVocabulary: vocab },
  );
  assert.equal(r.title, 'A Play');
  assert.equal(r.steps[0].oracle, 'corpus-venue');
});

test('is idempotent — normalising twice equals normalising once', () => {
  const once = normalizeShowTitle({
    id: 'x', title: 'THIS IS NOT ABOUT ME. (59E59 Theaters)', venue: '59E59 Theaters, Theater C',
  }).title;
  const twice = normalizeShowTitle({ id: 'x', title: once, venue: '59E59 Theaters, Theater C' }).title;
  assert.equal(twice, once);
});

test('strips MULTIPLE trailing parentheticals in one call', () => {
  // A single pass left "A Play (Luna Stage)", so the sweep reported success
  // while validate-data.js still failed the same row. Adversarial review
  // finding, reproduced against the real helper.
  const r = normalizeShowTitle({ id: 'x', title: 'A Play (Luna Stage) (Soho Playhouse)', venue: 'Elsewhere' });
  assert.equal(r.title, 'A Play');
  assert.equal(r.steps.filter(s => s.kind === 'venue-suffix').length, 2);
});

test('ingestion has no id yet, so exemptions must also key on the title', () => {
  // The id is DERIVED from the normalised title, so it cannot be an input.
  const r = normalizeShowTitle({ title: 'MÁS SABE EL SAULO POR VIEJO...' });
  assert.equal(r.manualReview, true, 'must be caught with no id supplied');
  assert.equal(r.changed, false, 'must not guess Spanish casing at ingestion');
});

test('missing or non-string titles are safe', () => {
  assert.equal(normalizeShowTitle({ id: 'x' }).changed, false);
  assert.equal(normalizeShowTitle({ id: 'x', title: null }).title, '');
  assert.equal(normalizeShowTitle(null).changed, false);
});

test('BRO-6268: a bare genre disambiguator is stripped without any venue vocabulary', () => {
  // Theatricalia's "(musical)" was only stripped when an unrelated venue
  // containing "Musical" happened to be in the corpus. No vocabulary here.
  const r = normalizeShowTitle({
    id: 'lend-me-a-tenor-musical-west-end-2011',
    title: 'Lend Me a Tenor (Musical)',
    venue: 'Gielgud Theatre',
  }, { venueVocabulary: [] });
  assert.equal(r.title, 'Lend Me a Tenor');
  assert.deepEqual(r.steps.map(s => s.kind), ['genre-disambiguator']);
  for (const t of ['Hamlet (play)', 'Carmen (opera)']) {
    assert.equal(normalizeShowTitle({ title: t }, { venueVocabulary: [] }).changed, true, t);
  }
});

test('BRO-6268: genre words that are part of the real title are left alone', () => {
  for (const t of ['Matilda The Musical', 'The Play That Goes Wrong', '(Musical)', 'A Musical (Comedy) Night']) {
    const r = normalizeShowTitle({ title: t }, { venueVocabulary: [] });
    assert.equal(r.title, t, t);
  }
});

// BRO-8051: trailing playwright byline, oracle = independent writer credit (NOT the id).
const { classifyPlaywrightByline, buildKnownWriters } = require('./show-title-normalize.js');
const corpus = [{ id: 'x', creativeTeam: [
  { name: 'Calamity West', role: 'Playwright' }, { name: 'William Shakespeare', role: 'Playwright' },
  { name: 'Stephen Sondheim', role: 'Music & Lyrics' }, { name: 'Ivo van Hove', role: 'Director' } ] }];
const knownWriters = buildKnownWriters(corpus);

test('BRO-8051: strips byline when name is a known writer', () => {
  const t = 'Engines and Instruments of Flight: A Fantasia in Three Acts by Calamity West';
  const r = normalizeShowTitle({ id: 'engines-regional-2026', title: t }, { knownWriters });
  assert.equal(r.title, 'Engines and Instruments of Flight: A Fantasia in Three Acts');
  assert.deepEqual(r.steps.map(s => s.kind), ['playwright-byline']);
  assert.equal(normalizeShowTitle({ id: 'h', title: 'Hamlet by William Shakespeare' }, { knownWriters }).title, 'Hamlet');
});

test('BRO-8051: show\'s own writer credit is an oracle without corpus data', () => {
  const r = normalizeShowTitle({ id: 'y', title: 'Tender by Jane Roe', creativeTeam: [{ name: 'Jane Roe', role: 'Author' }] });
  assert.equal(r.title, 'Tender');
});

test('BRO-8051: real "by" titles untouched, id slug is NOT an oracle', () => {
  for (const title of ['Side by Side by Sondheim', 'North by Northwest', 'Alice By Heart', 'Damned by Despair',
    'Stories By Heart', 'Stand by Your Man', 'Killed by Grace Kelly', 'Directed by Ivo van Hove', 'Inspired by True Events']) {
    // id minted from the title (the real ingestion shape) must not make it strip
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-regional-2026';
    assert.equal(normalizeShowTitle({ id, title }, { knownWriters }).title, title, title);
  }
  // no oracle data at all => never strip
  assert.equal(classifyPlaywrightByline('Hamlet by William Shakespeare', { id: 'hamlet-by-william-shakespeare' }), null);
  // a director is not a writer
  assert.equal(classifyPlaywrightByline('Hamlet by Ivo van Hove', {}, knownWriters), null);
});

test('BRO-8051: credit-style titles keep their credit word / writer name', () => {
  const kw = buildKnownWriters([{ creativeTeam: [
    { name: 'Cole Porter', role: 'Music & Lyrics' }, { name: 'Stephen Sondheim', role: 'Music & Lyrics' } ] }]);
  for (const title of ['Words and Music by Cole Porter', 'Music by Cole Porter', 'Written by Cole Porter',
    'Sondheim on Sondheim by Stephen Sondheim']) {
    assert.equal(normalizeShowTitle({ id: 'z', title }, { knownWriters: kw }).title, title, title);
  }
});

// BRO-8054: the source description is a third oracle, so a first-time playwright
// (no creative credit yet, not in the corpus) is still recognised.
const BYLINE = 'Engines and Instruments of Flight: A Fantasia in Three Acts by Calamity West';
const BYLINE_CLEAN = 'Engines and Instruments of Flight: A Fantasia in Three Acts';

test('BRO-8054: source description naming the writer is an oracle', () => {
  const r = normalizeShowTitle({ id: 'engines-2026', title: BYLINE }, { sourceText: 'A new play by Calamity West, directed by Ann Lee.' });
  assert.equal(r.title, BYLINE_CLEAN);
  assert.ok(r.steps.some((st) => st.oracle === 'source-description'));
});

test('BRO-8054: no oracle, no strip (description that does not name the writer)', () => {
  const r = normalizeShowTitle({ id: 'engines-2026', title: BYLINE }, { sourceText: 'A play about flight, directed by Ann Lee.' });
  assert.equal(r.title, BYLINE);
  assert.equal(r.changed, false);
});

test('BRO-8054: a real "by" title is not stripped just because the description repeats it', () => {
  const r = normalizeShowTitle({ id: 'killed-2026', title: 'Killed by Grace Kelly' }, { sourceText: 'Killed by Grace Kelly is a new comedy.' });
  assert.equal(r.title, 'Killed by Grace Kelly');
});

test('BRO-8054: the strip never leaves a one-word title', () => {
  const r = normalizeShowTitle({ id: 'tender-2026', title: 'Tender by Jane Roe' }, { sourceText: 'Tender by Jane Roe' });
  assert.equal(r.title, 'Tender by Jane Roe');
});

test('BRO-8054: apply records provenance + alias, undo restores every field', () => {
  const show = { id: 'a', title: BYLINE, akaTitles: ['Other'] };
  const result = normalizeShowTitle(show, { sourceText: 'by Calamity West' });
  const healed = applyNormalizedTitle(show, result, '2026-11-22T00:00:00.000Z');
  assert.equal(show.title, BYLINE_CLEAN);
  assert.equal(show.titleNormalizedFrom, BYLINE);
  assert.equal(show.titleNormalizedAt, '2026-11-22T00:00:00.000Z');
  assert.deepEqual(show.akaTitles, ['Other', BYLINE]);
  undoNormalizedTitle(show, healed);
  assert.deepEqual(show, { id: 'a', title: BYLINE, akaTitles: ['Other'] });
});

test('BRO-8054: healShowTitles honours `only`, and skips shouted titles', () => {
  const writer = [{ name: 'Calamity West', role: 'Playwright' }];
  const rows = [
    { id: 'a', title: BYLINE, creativeTeam: writer },
    { id: 'b', title: BYLINE, creativeTeam: writer },
    { id: 'c', title: 'AMERICA, WHO HURT YOU?' },
  ];
  const healed = healShowTitles(rows, { only: (s) => s.id !== 'b' });
  assert.deepEqual(healed.map((h) => h.id), ['a']);
  assert.equal(rows[1].title, BYLINE);
  assert.equal(rows[2].title, 'AMERICA, WHO HURT YOU?');
});

test('BRO-8054: a name in the description is not enough, the writer must be credited as writer', () => {
  // Subject of a biographical show: no subtitle left, no writer cue.
  const a = normalizeShowTitle({ id: 'songs-2026', title: 'Songs Inspired by Nina Simone' }, { sourceText: 'An evening of music celebrating Nina Simone and her era.' });
  assert.equal(a.title, 'Songs Inspired by Nina Simone');
  // Director credit never counts, even with a subtitle left over.
  const b = normalizeShowTitle({ id: 'ham-2026', title: 'Hamlet: A New Version by Ivo van Hove' }, { sourceText: 'Directed by Ivo van Hove, this Hamlet runs 3 hours.' });
  assert.equal(b.title, 'Hamlet: A New Version by Ivo van Hove');
  // Explicit writer cue works without a subtitle.
  const c = normalizeShowTitle({ id: 'eng-2026', title: 'Winter Light Years by Jane Roe' }, { sourceText: 'A new play written by Jane Roe.' });
  assert.equal(c.title, 'Winter Light Years');
});

// BRO-8054 ship-check: the corpus oracle is weaker than a show's own credit, and the automatic
// writers (write guard, TIC) must never turn a tribute title into a fragment.
test('BRO-8054: a known writer that is the SUBJECT of the title is never stripped', () => {
  const kw = new Set(['bob dylan', 'carole king', 'nina simone', 'agatha christie']);
  for (const t of ['Songs Inspired by Bob Dylan', 'A Night Inspired by Carole King', 'Portrait: Songs Inspired by Nina Simone', 'An Evening Celebrating Nina Simone by Nina Simone']) {
    assert.equal(normalizeShowTitle({ id: 'x', title: t }, { knownWriters: kw, minRemainderWords: 2 }).title, t, t);
  }
  // even the report-only sweep (floor 1) keeps the dangling-tail rule
  assert.equal(normalizeShowTitle({ id: 'x', title: 'Songs Inspired by Bob Dylan' }, { knownWriters: kw }).title, 'Songs Inspired by Bob Dylan');
});

test('BRO-8054: automatic writers never leave a one-word title (floor 2); the sweep keeps its floor 1', () => {
  const kw = new Set(['agatha christie', 'william shakespeare']);
  assert.equal(normalizeShowTitle({ id: 'x', title: 'Murdered by Agatha Christie' }, { knownWriters: kw, minRemainderWords: 2 }).title, 'Murdered by Agatha Christie');
  assert.equal(normalizeShowTitle({ id: 'x', title: 'Hamlet by William Shakespeare' }, { knownWriters: kw }).title, 'Hamlet');
});

test('BRO-8054: staged/conceived/choreographed credits in the description are not writer credits', () => {
  const t = 'Winter Light: A New Dance Piece by Jane Roe';
  for (const d of ['Staged by Jane Roe.', 'Conceived by Jane Roe and company.', 'Choreographed by Jane Roe.']) {
    assert.equal(normalizeShowTitle({ id: 'x', title: t }, { sourceText: d }).title, t, d);
  }
});
