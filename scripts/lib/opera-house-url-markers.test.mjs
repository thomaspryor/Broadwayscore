// BRO-6782: ROH/ENO/SFO shows keep their own house's URL markers; the Met's are rejected for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cf = require('./content-filters.js');
const { filterOperaUrls } = require('./site-search-discovery.js');

const eno = 'https://bachtrack.com/review-tosca-english-national-opera-london-coliseum-october-2026';
const met = 'https://operawire.com/metropolitan-opera-2026-27-review-tosca/';
const sfo = 'https://operawire.com/san-francisco-opera-2026-27-review-simon-boccanegra/';

test('Met shows still reject every other house (unchanged behaviour)', () => {
  assert.equal(cf.hasNonMetOperaUrlMarker(eno).rejected, true);
  assert.equal(cf.hasNonMetOperaUrlMarker(sfo).rejected, true);
  assert.equal(cf.hasNonMetOperaUrlMarker(met).rejected, false);
});

test('ENO/SFO/ROH shows keep their own house and reject the Met', () => {
  assert.equal(cf.hasNonMetOperaUrlMarker(eno, 'eno').rejected, false);
  assert.equal(cf.hasNonMetOperaUrlMarker(met, 'eno').rejected, true);
  assert.equal(cf.hasNonMetOperaUrlMarker(sfo, 'sfo').rejected, false);
  assert.equal(cf.hasNonMetOperaUrlMarker(eno, 'sfo').rejected, true);
  assert.equal(cf.hasNonMetOperaUrlMarker('https://x.com/royal-opera-house-hercules-review', 'roh').rejected, false);
  assert.equal(cf.hasNonMetOperaUrlMarker('https://x.com/royal-opera-house-hercules-review', 'eno').rejected, true);
});

test('operaHouseForVenue', () => {
  assert.equal(cf.operaHouseForVenue('London Coliseum'), 'eno');
  assert.equal(cf.operaHouseForVenue('War Memorial Opera House'), 'sfo');
  assert.equal(cf.operaHouseForVenue('Royal Opera House'), 'roh');
  assert.equal(cf.operaHouseForVenue('Metropolitan Opera House'), null);
});

test('filterOperaUrls passes a house show its own URLs when venue is given', () => {
  assert.deepEqual(filterOperaUrls([eno, met], 'bachtrack', 'x', null, 'London Coliseum'), [eno]);
  assert.deepEqual(filterOperaUrls([eno, met], 'bachtrack', 'x', null, 'Metropolitan Opera House'), [met]);
});

test('social autopost house tag follows the venue for SFO/ENO, category otherwise (BRO-6782)', async () => {
  const { createRequire } = await import('node:module');
  const { operaHouseTag } = createRequire(import.meta.url)('../social-autopost/config.js');
  assert.equal(operaHouseTag({ venue: 'War Memorial Opera House', category: 'off-broadway' }), 'SFOpera');
  assert.equal(operaHouseTag({ venue: 'London Coliseum', category: 'west-end' }), 'ENO');
  assert.equal(operaHouseTag({ venue: 'Metropolitan Opera House', category: 'off-broadway' }), 'MetOpera');
});
