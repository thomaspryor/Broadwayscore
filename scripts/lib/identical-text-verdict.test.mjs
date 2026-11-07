/**
 * Tests for scripts/lib/identical-text-verdict.js (BRO-5321).
 * Run: node --test scripts/lib/identical-text-verdict.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { textOverlap, structuredAuthors, sameCritic, textAuthor, groupVerdict } = require('./identical-text-verdict.js');

const words = (n, seed) => Array.from({ length: n }, (_, i) => `w${seed}x${i}`).join(' ');
const stored = words(200, 'a');

test('textOverlap: 1 for a page carrying the text, 0 for another article, null for short text', () => {
  assert.equal(textOverlap(stored, `<html><p>${stored}</p></html>`), 1);
  assert.equal(textOverlap(stored, `<html><p>${words(200, 'b')}</p></html>`), 0);
  assert.equal(textOverlap('too short', '<p>too short</p>'), null);
});

test('structuredAuthors keeps JSON-LD/meta person names, drops chrome bylines and org names', () => {
  const sig = ['meta: https://www.facebook.com/entertainmentweekly', 'jsonld: Leah Greenblatt', 'meta: Leah Greenblatt',
    'byline: By Andrew Wallenstein', 'jsonld: Variety Staff', 'jsonld: Associated Press'];
  assert.deepEqual(structuredAuthors(sig), ['Leah Greenblatt']);
  assert.deepEqual(structuredAuthors(['jsonld: Jesse Green and Sara Holdren']), ['Jesse Green', 'Sara Holdren']);
});

test('sameCritic: full name, initial + surname, diacritics; different people differ', () => {
  assert.ok(sameCritic('David Rooney', 'david rooney'));
  assert.ok(sameCritic('Joe Dziemianowicz', 'J. Dziemianowicz'));
  assert.ok(sameCritic('Brontë Smith', 'Bronte Smith'));
  assert.ok(!sameCritic('Charles Isherwood', 'David Rooney'));
  assert.ok(!sameCritic('Sara Holdren', 'Jesse Green'));
});

const isherwood = { file: 'variety--charles-isherwood.json', critic: 'Charles Isherwood', url: 'https://variety.com/2007/legit/reviews/deuce-1200558823/' };
const rooney = { file: 'variety--david-rooney.json', critic: 'David Rooney', url: 'https://variety.com/2007/legit/reviews/deuce-1200558841/' };

test('textAuthor: the page that carries the text names the author (deuce-2007 fixture)', () => {
  const pages = [
    { url: isherwood.url, authors: ['meta: David Rooney', 'jsonld: David Rooney'], overlap: 0.96 },
    { url: rooney.url, authors: ['meta: Terry Morgan', 'jsonld: Terry Morgan'], overlap: 0 },
  ];
  assert.deepEqual(textAuthor([isherwood, rooney], pages), { author: 'David Rooney', basis: 'page-with-text', url: isherwood.url });
});

test('textAuthor: paywalled same-url pair falls back to the url byline; different urls stay unverified', () => {
  const u = 'https://www.nytimes.com/2018/11/01/theater/torch-song-review.html';
  const a = { file: 'nytimes--ben-brantley.json', critic: 'Ben Brantley', url: u };
  const b = { file: 'nytimes--matt-windman.json', critic: 'Matt Windman', url: `${u}?smid=tw` };
  assert.equal(textAuthor([a, b], [{ url: u, authors: ['meta: Ben Brantley'], overlap: 0.1 }]).basis, 'same-url-byline');
  assert.equal(textAuthor([isherwood, rooney], [{ url: isherwood.url, authors: ['meta: David Rooney'], overlap: 0.1 }]).basis, 'unverified');
});

test('textAuthor: two pages carrying the text under different bylines is a conflict, not a guess', () => {
  const pages = [
    { url: isherwood.url, authors: ['jsonld: David Rooney'], overlap: 0.9 },
    { url: rooney.url, authors: ['jsonld: Terry Morgan'], overlap: 0.9 },
  ];
  assert.equal(textAuthor([isherwood, rooney], pages).author, null);
});

test('groupVerdict: shown-wrong when the counted copy names the wrong critic and the right one is stored', () => {
  const pages = [{ url: isherwood.url, authors: ['jsonld: David Rooney'], overlap: 0.95 }];
  const v = groupVerdict([{ ...isherwood, shown: true }, { ...rooney, shown: false }], pages);
  assert.equal(v.kind, 'shown-wrong');
  assert.deepEqual(v.right, ['variety--david-rooney.json']);
  assert.equal(groupVerdict([{ ...isherwood, shown: false }, { ...rooney, shown: true }], pages).kind, 'shown-correct');
  assert.equal(groupVerdict([{ ...isherwood, shown: true }], [{ url: isherwood.url, authors: ['jsonld: Terry Morgan'], overlap: 0.95 }]).kind, 'author-not-stored');
  assert.equal(groupVerdict([{ ...isherwood, shown: true }, { ...rooney, shown: false }], []).kind, 'unverified');
});
