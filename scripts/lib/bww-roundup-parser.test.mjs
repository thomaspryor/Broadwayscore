/**
 * bww-roundup-parser regression tests.
 *
 * Fixture is the REAL articleBody of
 * https://www.broadwayworld.com/westend/article/Review-Roundup-THE-COMEDY-ABOUT-SPIES-from-Mischief-Theatre-20250514
 * captured live 2026-08-01. It reproduces two production failures at once:
 *
 *   1. "Photo credit: Mark Senior     Franco Milazzo, BroadwayWorld:" — the
 *      photographer's SURNAME was absorbed as the first word of the next
 *      byline, because the name pattern's `\s+` word separator happily spanned
 *      the 5-space block gap BWW uses between entries. The pipeline persisted a
 *      phantom second BroadwayWorld critic ("Senior     Franco Milazzo") with
 *      no URL, so same-URL dedup could not collapse it and the same review was
 *      double-counted on the-comedy-about-spies-west-end-2026.
 *
 *   2. "Ryan Gilbey , The Guardian:" / "Holly O'Mahony , The Stage:" — a stray
 *      space before the comma made the pattern skip those entries entirely.
 *      Only 6 of the article's 8 critics parsed.
 *
 * Per CLAUDE.md rule 15 this require()s the real parser — no logic is copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArticleBodyReviews } = require('./bww-roundup-parser.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', 'tests', 'fixtures', 'bww-roundups', 'the-comedy-about-spies-2026.articleBody.txt');
const articleBody = readFileSync(FIXTURE, 'utf8');

test('parses every critic in the live SPIES roundup body', () => {
  const parsed = parseArticleBodyReviews(articleBody);
  const names = parsed.map(r => r.criticName);

  assert.deepEqual(names, [
    'Franco Milazzo',
    'Ryan Gilbey',
    'Nick Curtis',
    'Dominic Cavendish',
    'Alun Hood',
    'Clive Davis',
    "Holly O'Mahony",
    'Aliya Al-Hassan',
  ], 'all 8 bylines parse with clean names');
});

test('photographer surname never bleeds into the following byline', () => {
  // "Photo credit: Mark Senior" immediately precedes the BroadwayWorld entry.
  const parsed = parseArticleBodyReviews(articleBody);
  for (const r of parsed) {
    assert.ok(!/\s{2,}/.test(r.criticName), `criticName has a whitespace run: ${JSON.stringify(r.criticName)}`);
    assert.ok(!/^Senior\b/.test(r.criticName), `criticName starts with photographer surname: ${JSON.stringify(r.criticName)}`);
  }
  const bww = parsed.filter(r => r.outletRaw === 'BroadwayWorld');
  assert.equal(bww.length, 1, 'exactly one BroadwayWorld entry — no phantom sibling');
  assert.equal(bww[0].criticName, 'Franco Milazzo');
});

test('a space before the comma does not drop the entry', () => {
  const parsed = parseArticleBodyReviews(articleBody);
  const byName = Object.fromEntries(parsed.map(r => [r.criticName, r.outletRaw]));
  // Both of these are written "Name , Outlet:" in the source.
  assert.equal(byName['Ryan Gilbey'], 'The Guardian');
  assert.equal(byName["Holly O'Mahony"], 'The Stage');
});

test('quotes are attributed to the right critic', () => {
  const parsed = parseArticleBodyReviews(articleBody);
  const gilbey = parsed.find(r => r.criticName === 'Ryan Gilbey');
  assert.match(gilbey.quote, /doll’s-house-style cross-section set/);
  const davis = parsed.find(r => r.criticName === 'Clive Davis');
  assert.match(davis.quote, /steals scene after scene as Douglas Woodbead/);
});

test('trailing photo credit terminates the last quote (case-insensitive)', () => {
  // BWW writes "Photo credit:" with a lower-case c. Synthetic tail because the
  // SPIES article puts its credit BEFORE the reviews.
  const body = "Let's see what the critics had to say Jane Doe, The Example: A fine evening out. Photo credit: Some Photographer";
  const parsed = parseArticleBodyReviews(body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].criticName, 'Jane Doe');
  assert.ok(!/[Pp]hoto/.test(parsed[0].quote), `photo credit leaked into quote: ${parsed[0].quote}`);
});

test('leading-initial bylines still parse (J. Kelly Nestruck regression)', () => {
  const body = "Let's see what the critics had to say J. Kelly Nestruck, The Globe and Mail: A triumph.";
  const parsed = parseArticleBodyReviews(body);
  assert.equal(parsed[0].criticName, 'J. Kelly Nestruck');
  assert.equal(parsed[0].outletRaw, 'The Globe and Mail');
});
