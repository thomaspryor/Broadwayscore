// BRO-733: BWW roundup entries lost their critic (or the whole entry) when the
// byline had accents or the outlet name contained a digit ("NY1").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseArticleBodyReviews } = require('./bww-roundup-parser.js');
const { extractAuthorFromHtml } = require('./content-quality.js');

const body = (entries) =>
  "Let's see what the critics had to say  " +
  entries.map(([n, o], i) => `${n}, ${o}: "Quote ${i} is a fine night out."  `).join('');

test('previously-working formats still parse', () => {
  const r = parseArticleBodyReviews(body([
    ['Brian Scott Lipton', 'Cititour'],
    ['Jonathan Mandell', 'New York Theater'],
    ['Charles Isherwood', 'The Wall Street Journal'],
    ['J. Kelly Nestruck', 'The Globe and Mail'],
  ]));
  assert.deepEqual(r.map((x) => x.criticName),
    ['Brian Scott Lipton', 'Jonathan Mandell', 'Charles Isherwood', 'J. Kelly Nestruck']);
});

test('accented bylines parse and do not swallow neighbours', () => {
  const r = parseArticleBodyReviews(body([
    ['Naveen Kumar', 'WSJ'], ['José Solís', 'New York Stage Review'], ['Helen Shaw', 'Cititour'],
  ]));
  assert.deepEqual(r.map((x) => x.criticName), ['Naveen Kumar', 'José Solís', 'Helen Shaw']);
  assert.ok(!r[0].quote.includes('Solís'));
});

test('digit-bearing outlet NY1 parses', () => {
  const r = parseArticleBodyReviews(body([['Helen Shaw', 'NY1'], ['Frank Scheck', 'New York Post']]));
  assert.deepEqual(r.map((x) => [x.criticName, x.outletRaw]), [['Helen Shaw', 'NY1'], ['Frank Scheck', 'New York Post']]);
});

test('page byline extraction handles accented / apostrophe / hyphen names', () => {
  for (const name of ['José Solís', "Sean O'Connor", 'Mary-Louise Parker']) {
    const html = `<p class="byline">By ${name}</p><p>body</p>`;
    assert.equal(extractAuthorFromHtml(html, 'body', { url: 'https://www.nytheater.com/x' }), name);
  }
});

test('space-separated number inside a quote does not mint a fake critic', () => {
  const r = parseArticleBodyReviews(
    "Let's see what the critics had to say  Jesse Green, New York Times: \"Great show. Star Daniel Radcliffe, age 35: still boyish.\"  Frank Scheck, New York Post: \"Fun.\"  ");
  assert.deepEqual(r.map((x) => x.criticName), ['Jesse Green', 'Frank Scheck']);
});

test('page byline does not absorb possessives or trailing punctuation', () => {
  const ex = (h) => extractAuthorFromHtml(h, 'x', { url: 'https://www.nytheater.com/x' });
  assert.equal(ex('<p class="byline">By Jane Doe\'s review</p>'), 'Jane Doe');
  assert.equal(ex('<p class="byline">By Jane Doe-Smith-</p>'), 'Jane Doe-Smith');
});
