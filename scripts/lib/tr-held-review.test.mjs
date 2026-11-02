/**
 * BRO-6507: Theatre Record lists 42nd Street (West End 2017) "Observer /
 * Susannah Clapp"; we hold it as guardian--susannah-clapp.json (the SERP
 * writer filed it by host). The extractor counted it new and would write a
 * second copy, so the coverage check reported 1-listed-not-held.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findHeldUnderRelatedOutlet, isSisterCopy, sameWeek } = require('./tr-held-review.js');
const { splitOutletForLabel } = require('./outlet-mismatch-heal.js');
const { normalizeOutlet } = require('./review-normalization.js');

function showDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-held-'));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}
const clapp = (publishDate) => ({ outletId: 'guardian', outlet: 'The Guardian', criticName: 'Susannah Clapp', publishDate, fullText: 'x'.repeat(400) });
// The extractor's own resolution of TR's label, so the test tracks the registry.
const ids = (label, critic) => {
  const parentOutletId = normalizeOutlet(label);
  return { parentOutletId, outletId: splitOutletForLabel(parentOutletId, label, critic) };
};

test('an Observer review held under the Guardian (same week) counts as held', () => {
  const dir = showDir({ 'guardian--susannah-clapp.json': clapp('2017-04-09') });
  const hit = findHeldUnderRelatedOutlet(dir, { ...ids('Observer', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09' });
  assert.ok(hit);
  assert.equal(hit.via, 'sister');
  assert.equal(path.basename(hit.path), 'guardian--susannah-clapp.json');
});

test('an existing observer-- file wins: the sister file is not consulted', () => {
  // 51 shows hold both copies; the observer file stays the merge target.
  const dir = showDir({ 'guardian--susannah-clapp.json': clapp('2017-04-09'), 'observer--susannah-clapp.json': { ...clapp('2017-04-09'), outletId: 'observer' } });
  assert.equal(findHeldUnderRelatedOutlet(dir, { ...ids('Observer', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09', ownFileExists: true }), null);
});

test('a sister-paper file by the same critic weeks apart is a different review', () => {
  const dir = showDir({ 'guardian--susannah-clapp.json': clapp('2017-05-20') });
  assert.equal(findHeldUnderRelatedOutlet(dir, { ...ids('Observer', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09' }), null);
});

test('a different critic under the sister paper is not held', () => {
  const dir = showDir({ 'guardian--michael-billington.json': { ...clapp('2017-04-09'), criticName: 'Michael Billington' } });
  assert.equal(findHeldUnderRelatedOutlet(dir, { ...ids('Observer', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09' }), null);
});

test('a review whose own outlet has no sister is untouched', () => {
  const dir = showDir({ 'guardian--susannah-clapp.json': clapp('2017-04-09') });
  assert.equal(findHeldUnderRelatedOutlet(dir, { ...ids('Evening Standard', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09' }), null);
});

test('the parent-label rule still holds (no date check)', () => {
  const dir = showDir({ 'times-uk--a.json': { outletId: 'times-uk', criticName: 'A B' } });
  const hit = findHeldUnderRelatedOutlet(dir, { parentOutletId: 'times-uk', outletId: 'sunday-times', critic: 'A B', date: '2017-04-09' },
    (d, outlet) => (outlet === 'times-uk' ? { path: path.join(d, 'times-uk--a.json'), data: { publishDate: '2001-01-01' } } : null));
  assert.equal(hit.via, 'parent');
});

test('an --unknown sister file is not the same critic', () => {
  const dir = showDir({ 'guardian--unknown.json': { ...clapp('2017-04-09'), criticName: 'Unknown' } });
  assert.equal(findHeldUnderRelatedOutlet(dir, { ...ids('Observer', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09' }), null);
  // Nor does an unknown TR critic match a named sister file.
  const named = showDir({ 'guardian--susannah-clapp.json': clapp('2017-04-09') });
  assert.equal(findHeldUnderRelatedOutlet(named, { parentOutletId: 'observer', outletId: 'observer', critic: 'Unknown', date: '2017-04-09' }), null);
});

test('a sunday-times file is not a times-uk sister copy (alias, not the sister)', () => {
  // TR "Sunday Times" -> sunday-times, sister times-uk. A lookup under times-uk
  // can alias onto sunday-times-- files; only a real times-uk file counts.
  const dir = showDir({ 'sunday-times--david-jays.json': { outletId: 'sunday-times', criticName: 'David Jays', publishDate: '2017-04-09', fullText: 'x'.repeat(400) } });
  const hit = findHeldUnderRelatedOutlet(dir, { parentOutletId: 'sunday-times', outletId: 'sunday-times', critic: 'David Jays', date: '2017-04-09' },
    (d, outlet) => (outlet === 'times-uk' ? { path: path.join(d, 'sunday-times--david-jays.json'), data: JSON.parse(fs.readFileSync(path.join(d, 'sunday-times--david-jays.json'), 'utf8')) } : null));
  assert.equal(hit, null);
  assert.equal(isSisterCopy({ data: { outletId: 'times-uk', criticName: 'David Jays', publishDate: '2017-04-09' } }, 'times-uk', 'David Jays', '2017-04-09'), true);
});

test('non-ISO dates parse; an unparseable or missing date is not held', () => {
  const held = (publishDate) => findHeldUnderRelatedOutlet(showDir({ 'guardian--susannah-clapp.json': clapp(publishDate) }),
    { ...ids('Observer', 'Susannah Clapp'), critic: 'Susannah Clapp', date: '2017-04-09' });
  assert.ok(held('April 9th, 2017'));
  assert.ok(held('9 April 2017'));
  assert.equal(held('sometime in spring'), null);
  assert.equal(held(null), null);
});

test('sameWeek needs both dates known and close', () => {
  assert.equal(sameWeek(null, '2017-04-09'), false);
  assert.equal(sameWeek('May 14th, 2025', '2025-05-15'), true);
  assert.equal(sameWeek('2017-04-04', '2017-04-09'), true);
  assert.equal(sameWeek('2017-03-01', '2017-04-09'), false);
});
