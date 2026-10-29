// Parsers for theatreinchicago.com (BRO-6518), pinned to saved real HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const t = require('./theatreinchicago.js');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'tic');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('listing: one entry per show with id, slug, venue and verdicts', () => {
  const list = t.parseListing(read('reviewlistings.html'));
  assert.equal(list.length, 39);
  const first = list.find((s) => s.id === 13522);
  assert.equal(first.slug, 'any-rebellion-of-will');
  assert.equal(first.title, 'Any Rebellion of Will');
  assert.equal(first.venue, 'Trap Door Theatre');
  assert.equal(first.reviewCount, 3);
  assert.deepEqual(first.reviews.map((r) => r.verdict), ['recommended', 'highly', 'highly']);
  assert.ok(list.every((s) => Number.isInteger(s.id) && s.title && s.venue));
});

test('reviews page: outlet, critic, verdict, excerpt, full-review url, venue, poster, closing', () => {
  const p = t.parseReviewsPage(read('reviews-13000-top-girls.html'));
  assert.equal(p.empty, false);
  assert.equal(p.id, 13000);
  assert.equal(p.slug, 'top-girls');
  assert.equal(p.title, 'Top Girls');
  assert.equal(p.venue, 'Raven Theatre');
  assert.equal(p.closingDate, '2026-03-22');
  assert.match(p.poster, /top-girls-raven-theatre\.jpg$/);
  assert.equal(p.reviews.length, 11);
  const trib = p.reviews[0];
  assert.equal(trib.outlet, 'Chicago Tribune');
  assert.equal(trib.critic, 'Emily McClanathan');
  assert.equal(trib.verdict, 'highly');
  assert.match(trib.excerpt, /^\.\.\.Caryl Churchill/);
  assert.match(trib.url, /^https?:\/\//);
  assert.ok(p.reviews.every((r) => r.outlet && r.verdict));
});

test('reviews page: second archive page (2023 run) parses', () => {
  const p = t.parseReviewsPage(read('reviews-12000-physician-magician.html'));
  assert.equal(p.title, 'Physician Magician');
  assert.equal(p.venue, 'The Rhapsody Theater');
  assert.equal(p.closingDate, '2024-06-01');
  assert.deepEqual(p.reviews.map((r) => r.outlet), ['Chicago Tribune', 'Chicago Reader', p.reviews[2].outlet]);
  assert.equal(p.reviews[0].critic, 'Chris Jones');
});

test('empty archive id is flagged empty with no reviews', () => {
  const p = t.parseReviewsPage(read('reviews-11500-empty.html'), 11500);
  assert.equal(p.empty, true);
  assert.equal(p.id, 11500);
  assert.deepEqual(p.reviews, []);
});

test('detail page: show type, venue, address, closing date', () => {
  const d = t.parseDetailPage(read('detail-12000-physician-magician.html'));
  assert.equal(d.title, 'Physician Magician');
  assert.equal(d.showType, 'Performance Art');
  assert.equal(d.venue, 'The Rhapsody Theater');
  assert.match(d.address, /1328 W\. Morse Ave/);
  assert.equal(d.closingDate, '2024-06-01');
  assert.equal(t.isExcludedType(d.showType), true);
});

test('type filter and mapping', () => {
  for (const x of ['Cabaret', 'Magic', 'Comedy', 'Stand-up Comedy', 'Improv']) assert.equal(t.isExcludedType(x), true, x);
  for (const x of ['Play', 'Musical', 'Drama', 'Comedy/Drama', 'Musical Comedy']) assert.equal(t.isExcludedType(x), false, x);
  assert.equal(t.mapShowType('Musical'), 'musical');
  assert.equal(t.mapShowType('Play'), 'play');
});

test('site date parsing and verdict normalising', () => {
  assert.equal(t.parseSiteDate('Thru - Jun 1, 2024'), '2024-06-01');
  assert.equal(t.parseSiteDate('Thru'), null);
  assert.equal(t.normalizeVerdict(' Somewhat Recommended '), 'somewhat');
  assert.equal(t.normalizeVerdict('Not Recommended'), 'not');
  assert.equal(t.normalizeVerdict('Highly Recommended'), 'highly');
  assert.equal(t.normalizeVerdict('x'), null);
});
