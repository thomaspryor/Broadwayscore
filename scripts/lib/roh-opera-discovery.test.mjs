import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const roh = require('./roh-opera-discovery.js');

const page = (desc, dates, h1 = 'Hercules') =>
  `<html><head><meta property="og:description" content="${desc}"></head><body><h1>${h1} | Royal Ballet and Opera</h1>` +
  dates.map(d => `<script type="application/ld+json">{"startDate":"${d}T18:30:00+01:00","endDate":"${d}T22:00:00+01:00"}</script>`).join('') +
  '</body></html>';

test('extractProductionSlugs keeps named productions, drops numeric ids and rehearsals', () => {
  const html = '<a href="/production/hercules-barrie-kosky">x</a><a href="/production/3069">n</a><a href="/production/friends-rehearsals">r</a><a href="/production/hercules-barrie-kosky">dup</a><a href="/production/manon-kenneth-macmillan">b</a>';
  assert.deepEqual(roh.extractProductionSlugs(html), ['hercules-barrie-kosky', 'manon-kenneth-macmillan']);
});

test('opera new production: dates, title, flags', () => {
  const p = roh.parseRohProduction(page("The Royal Opera&#x27;s Handel series continues with Barrie Kosky&#39;s new production", ['2027-07-09', '2027-06-18', '2027-06-21']), 'hercules-barrie-kosky');
  assert.equal(p.title, 'Hercules');
  assert.equal(p.isOpera, true);
  assert.equal(p.isNewProduction, true);
  assert.equal(p.openingDate, '2027-06-18');
  assert.equal(p.closingDate, '2027-07-09');
});

test('ballet page is not opera; revival is not a new production', () => {
  const ballet = roh.parseRohProduction(page('The Royal Ballet presents a new production of Manon', ['2027-03-01']), 'manon');
  assert.equal(ballet.isOpera, false);
  const revival = roh.parseRohProduction(page('The Royal Opera revives Tosca', ['2027-03-01'], 'Tosca'), 'tosca');
  assert.equal(revival.isOpera, true);
  assert.equal(revival.isNewProduction, false);
});

test('buildRohShowEntry matches the A Masked Ball row shape', () => {
  const p = roh.parseRohProduction(page('The Royal Opera new production', ['2027-01-21', '2027-02-07'], 'Götterdämmerung'), 'gotterdammerung-barrie-kosky');
  const { id, idPrefix, entry } = roh.buildRohShowEntry(p, '2026-11-01');
  assert.equal(id, 'gotterdammerung-off-west-end-2027');
  assert.equal(idPrefix, 'gotterdammerung-off-west-end');
  assert.equal(entry.venue, 'Royal Opera House');
  assert.equal(entry.type, 'opera');
  assert.equal(entry.category, 'off-west-end');
  assert.equal(entry.market, 'west-end');
  assert.equal(entry.status, 'upcoming');
  assert.equal(entry.provisional, true);
});

test('deriveStatus', () => {
  assert.equal(roh.deriveStatus('2026-10-01', '2026-10-17', '2026-11-01'), 'closed');
  assert.equal(roh.deriveStatus('2026-10-01', '2026-11-20', '2026-11-01'), 'open');
});
