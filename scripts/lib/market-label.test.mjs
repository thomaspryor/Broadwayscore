import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getMarketLabel, isNonMetroMarket, getRegionalPromptContext, isUkRegionalVenue } = require('./market-label.js');
const { buildWrongProductionUserPrompt } = require('./classifier-prompts.js');

test('every known market gets its own label — none falls through to Broadway', () => {
  assert.equal(getMarketLabel('broadway'), 'Broadway');
  assert.equal(getMarketLabel('off-broadway'), 'Off-Broadway');
  assert.equal(getMarketLabel('west-end'), 'West End');
  assert.equal(getMarketLabel('off-west-end'), 'Off-West End');
  assert.match(getMarketLabel('regional'), /^Regional/);
});

test('regional is NEVER labelled Broadway (the Family Album regression, 2026-07-30)', () => {
  // The original bug: an inline ternary ended `: 'Broadway'`, so the prompt read
  // "The Family Album at La Jolla Playhouse (Broadway)" and both ensemble legs
  // rejected the review as wrong_production.
  assert.notEqual(getMarketLabel('regional'), 'Broadway');
  assert.doesNotMatch(getMarketLabel('regional'), /Broadway/);
});

test('unknown market slugs echo back rather than silently becoming Broadway', () => {
  assert.equal(getMarketLabel('edinburgh-fringe'), 'edinburgh-fringe');
  assert.equal(getMarketLabel('tour'), 'tour');
});

test('absent market still defaults to Broadway (the real majority case)', () => {
  assert.equal(getMarketLabel(undefined), 'Broadway');
  assert.equal(getMarketLabel(null), 'Broadway');
  assert.equal(getMarketLabel(''), 'Broadway');
});

test('lookup is case- and whitespace-insensitive', () => {
  assert.match(getMarketLabel(' Regional '), /^Regional/);
  assert.equal(getMarketLabel('WEST-END'), 'West End');
});

test('isNonMetroMarket identifies regional only', () => {
  assert.equal(isNonMetroMarket('regional'), true);
  assert.equal(isNonMetroMarket('broadway'), false);
  assert.equal(isNonMetroMarket('off-broadway'), false);
  assert.equal(isNonMetroMarket('west-end'), false);
  assert.equal(isNonMetroMarket(undefined), false);
});

test('regional prompt context tells the model not to flag non-Broadway as a mismatch', () => {
  const note = getRegionalPromptContext('La Jolla Playhouse');
  assert.match(note, /La Jolla Playhouse/);
  assert.match(note, /do NOT flag/);
  assert.match(note, /wrong_production/);
  // Works without a venue too.
  assert.match(getRegionalPromptContext(undefined), /REGIONAL production/);
});

test('a UK regional venue is labelled UK, not US — card #1405 (RSC Stratford)', () => {
  // The bug: getMarketLabel('regional') hardcoded "(US, outside New York)", so
  // an RSC Stratford-upon-Avon world premiere was announced to the ensemble as
  // a US production. The review body says England in its first paragraph, so
  // both legs answer wrong_production and the review is dropped.
  const uk = getMarketLabel('regional', 'Royal Shakespeare Theatre, Stratford-upon-Avon');
  assert.match(uk, /^Regional/);
  assert.match(uk, /UK/);
  assert.doesNotMatch(uk, /US/);
  assert.doesNotMatch(uk, /New York/);

  // Chichester is the other entry in data/uk-regional-venues.json.
  assert.match(getMarketLabel('regional', 'Chichester Festival Theatre'), /UK/);

  // A US regional house keeps the US wording.
  const us = getMarketLabel('regional', 'La Jolla Playhouse, La Jolla, CA');
  assert.match(us, /US/);
  assert.doesNotMatch(us, /UK/);

  // No venue supplied → unchanged pre-#1405 behaviour.
  assert.equal(getMarketLabel('regional'), getMarketLabel('regional', undefined));
  assert.match(getMarketLabel('regional'), /US/);

  // Non-regional markets ignore the venue argument entirely.
  assert.equal(getMarketLabel('west-end', 'Royal Shakespeare Theatre'), 'West End');
  assert.equal(getMarketLabel('broadway', 'Royal Shakespeare Theatre'), 'Broadway');
});

test('isUkRegionalVenue matches the shared table case-insensitively', () => {
  assert.equal(isUkRegionalVenue('Royal Shakespeare Theatre, Stratford-upon-Avon'), true);
  assert.equal(isUkRegionalVenue('ROYAL SHAKESPEARE THEATRE'), true);
  assert.equal(isUkRegionalVenue('Chichester Festival Theatre'), true);
  assert.equal(isUkRegionalVenue('La Jolla Playhouse'), false);
  assert.equal(isUkRegionalVenue(''), false);
  assert.equal(isUkRegionalVenue('   '), false);
  assert.equal(isUkRegionalVenue(undefined), false);
  assert.equal(isUkRegionalVenue(null), false);
});

test('isUkRegionalVenue rejects non-strings instead of coercing them', () => {
  // String(['Royal Shakespeare Theatre']) === 'Royal Shakespeare Theatre', so a
  // coercing implementation matches an ARRAY. getMarketLabel's optional 2nd
  // param means `arr.map(getMarketLabel)` would pass the index as venue; both
  // must be inert.
  assert.equal(isUkRegionalVenue(['Royal Shakespeare Theatre']), false);
  assert.equal(isUkRegionalVenue({ name: 'Royal Shakespeare Theatre' }), false);
  assert.equal(isUkRegionalVenue(0), false);
  assert.equal(isUkRegionalVenue(1), false);
  assert.equal(isUkRegionalVenue(true), false);
  // These two assertions are the ones with teeth. A COERCING implementation
  // (String(venue).includes(...)) returns the UK label for the array case,
  // because String(['Royal Shakespeare Theatre']) is the bare venue name — so
  // this fails against the broken version and passes against the fixed one.
  const usLabel = getMarketLabel('regional');
  assert.equal(getMarketLabel('regional', ['Royal Shakespeare Theatre']), usLabel);
  assert.equal(getMarketLabel('regional', { toString: () => 'Chichester Festival Theatre' }), usLabel);

  // The map() footgun specifically: Array#map passes (value, index, array), so
  // the 2nd arg is a NUMBER. Asserting against the no-venue label (not against
  // another map call) is what makes this a regression guard rather than a
  // tautology — it pins the output to a known-correct value.
  assert.deepEqual(['regional', 'regional', 'regional'].map(getMarketLabel), [usLabel, usLabel, usLabel]);
});

test('regional prompt note names the right country for a UK house — card #1405', () => {
  const uk = getRegionalPromptContext('Royal Shakespeare Theatre, Stratford-upon-Avon');
  assert.match(uk, /UK theatre outside London/);
  assert.doesNotMatch(uk, /US theater outside New York/);
  // The "not X" clause must name the UK metro, not Broadway.
  assert.match(uk, /West End/);
  assert.match(uk, /do NOT flag/);

  const us = getRegionalPromptContext('La Jolla Playhouse');
  assert.match(us, /US theater outside New York/);
  assert.match(us, /Broadway/);
});

test('classifier prompt files a UK regional show under Regional (UK) — card #1405', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: {
      title: 'Game of Thrones: The Mad King',
      market: 'regional',
      venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon',
    },
    result: {
      showId: 'game-of-thrones-the-mad-king-regional-2026',
      showYear: 2026,
      outlet: 'The Guardian',
      criticName: 'Unknown',
      publishDate: '2026-08-09',
      signals: [],
    },
    reviewData: { fullText: 'A world premiere at the RSC in Stratford-upon-Avon.' },
    revivals: [],
  });
  assert.match(prompt, /FILED UNDER PRODUCTION: \S+ \(Regional \(UK, outside London\) opening: 2026\)/);
  assert.match(prompt, /UK theatre outside London/);
  assert.doesNotMatch(prompt, /Regional \(US, outside New York\)/);
  assert.doesNotMatch(prompt, /US theater outside New York/);
});

test('classifier prompt files a regional show under Regional, not Broadway', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: {
      title: 'The Family Album',
      market: 'regional',
      venue: 'Sheila and Hughes Potiker Theatre, La Jolla Playhouse, La Jolla, CA',
    },
    result: {
      showId: 'the-family-album-regional-2026',
      showYear: 2026,
      outlet: 'BroadwayWorld',
      criticName: 'ErinMarie Reiter',
      publishDate: '2026-07-28',
      signals: [],
    },
    reviewData: { fullText: 'A world premiere musical at La Jolla Playhouse.' },
    revivals: [],
  });
  assert.doesNotMatch(prompt, /\(Broadway opening/);
  assert.match(prompt, /FILED UNDER PRODUCTION: \S+ \(Regional[\s\S]*?opening: 2026\)/);
  assert.match(prompt, /do NOT flag/);
});

test('classifier prompt still says Broadway for an actual Broadway show', () => {
  const prompt = buildWrongProductionUserPrompt({
    show: { title: 'Hamilton', market: 'broadway', venue: 'Richard Rodgers Theatre' },
    result: { showId: 'hamilton', showYear: 2015, signals: [] },
    reviewData: { fullText: 'text' },
    revivals: [],
  });
  assert.match(prompt, /\(Broadway opening: 2015\)/);
  assert.doesNotMatch(prompt, /REGIONAL production/);
});
