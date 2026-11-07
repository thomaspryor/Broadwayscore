/**
 * BRO-3630: "Ruthless! The Musical" was a zero-results search. Guards the
 * catalogue entry (Playbill: St. Luke's Theatre, previews 2015-06-25, opened
 * 2015-07-13, closed 2016-09-10). Skips when core data is not checked out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/shows.json');
const have = fs.existsSync(file);
const shows = have ? JSON.parse(fs.readFileSync(file, 'utf8')).shows : [];
const show = shows.find((s) => s.id === 'ruthless-the-musical-off-broadway-2015');

test('Ruthless! The Musical is present in shows.json', { skip: !have }, () => {
  assert.ok(show, 'ruthless-the-musical-off-broadway-2015 missing');
  assert.equal(show.title, 'Ruthless! The Musical');
  assert.ok(shows.some((s) => /ruthless/i.test(s.title)), 'search "ruthless" must match a title');
});

test('Ruthless! data integrity matches Playbill', { skip: !have }, () => {
  assert.equal(show.venue, "St. Luke's Theatre");
  assert.equal(show.category, 'off-broadway');
  assert.equal(show.type, 'musical');
  assert.equal(show.previewsStartDate, '2015-06-25');
  assert.equal(show.openingDate, '2015-07-13');
  assert.equal(show.closingDate, '2016-09-10');
  assert.equal(show.status, 'closed');
  assert.ok(show.previewsStartDate < show.openingDate && show.openingDate < show.closingDate);
  assert.equal(shows.filter((s) => s.slug === show.slug).length, 1, 'slug unique');
});
