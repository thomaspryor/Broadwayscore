import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getMarketLabel, isNonMetroMarket, getRegionalPromptContext } = require('./market-label.js');
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
