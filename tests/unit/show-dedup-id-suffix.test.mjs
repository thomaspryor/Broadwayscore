// BRO-4204 S5-T3: one shared id-suffix rule (scripts/lib/market-slug.js
// stripIdSuffix) for deduplication.js Check 3 and validate-shows-prebuild.js's
// idBaseIndex. Each carried a private regex listing only west-end|off-broadway,
// so `holy-fool-off-west-end-2026` stripped to `holy-fool-off` and the Off
// West End row never collided in the id-base index. Per CLAUDE.md §15 the
// real functions are require()d.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stripIdSuffix, MARKET_SUFFIXES } = require('../../scripts/lib/market-slug.js');
const { checkForDuplicate } = require('../../scripts/lib/deduplication.js');

test('stripIdSuffix strips a trailing market suffix and/or year from a show id', () => {
  assert.equal(stripIdSuffix('holy-fool-off-west-end-2026'), 'holy-fool', '-off-west-end-2026 is the case the local regexes missed');
  assert.equal(stripIdSuffix('evita-2026'), 'evita');
  assert.equal(stripIdSuffix('phantom-west-end-1986'), 'phantom');
  assert.equal(stripIdSuffix('some-show-off-broadway'), 'some-show', 'market suffix without a year');
  assert.equal(stripIdSuffix('some-show-off-broadway-2025'), 'some-show');
  assert.equal(stripIdSuffix('hamilton'), 'hamilton', 'nothing to strip');
});

test('stripIdSuffix leaves non-market id tags alone — asserting current behaviour explicitly', () => {
  // "-bway-" and "-regional-" are id tags, not market suffixes (MARKET_SUFFIXES
  // is off-west-end / west-end / off-broadway); only the year comes off.
  assert.equal(stripIdSuffix('two-strangers-bway-2025'), 'two-strangers-bway');
  assert.equal(stripIdSuffix('little-bear-ridge-road-regional-2024'), 'little-bear-ridge-road-regional');
  assert.equal(stripIdSuffix('pride-bridge-theatre-off-west-end-2026'), 'pride-bridge-theatre', 'a venue tag before the market suffix stays');
  assert.deepEqual(MARKET_SUFFIXES, ['off-west-end', 'west-end', 'off-broadway']);
});

test('stripIdSuffix only strips trailing suffixes, never mid-id occurrences, and tolerates empty input', () => {
  assert.equal(stripIdSuffix('west-end-girls-2024'), 'west-end-girls');
  assert.equal(stripIdSuffix('an-off-broadway-story'), 'an-off-broadway-story');
  assert.equal(stripIdSuffix(''), '');
  assert.equal(stripIdSuffix(undefined), '');
});

test('Check 3 (id-base match) now sees an -off-west-end-2026 catalog id', () => {
  const holyFool = {
    id: 'holy-fool-off-west-end-2026',
    title: 'Holy Fool',
    slug: 'holy-fool-off-west-end',
    category: 'off-west-end',
    venue: 'Park Theatre',
    status: 'open',
    previewsStartDate: '2026-08-27',
    openingDate: '2026-09-04',
    closingDate: '2026-10-10',
  };
  // "Holy Fool!" misses Check 1 (exact title) and Check 2 (exact slug) so the
  // verdict has to come from the id base: slugify → "holy-fool" vs the
  // catalog id's base, which used to be "holy-fool-off".
  const candidate = { title: 'Holy Fool!', category: 'off-west-end', venue: 'Park Theatre', status: 'previews', previewsStartDate: '2026-08-27', openingDate: null };
  const r = checkForDuplicate(candidate, [holyFool]);
  assert.equal(r.isDuplicate, true);
  assert.match(r.reason, /^ID base match: "holy-fool" matches existing "holy-fool-off-west-end-2026"/);
});
