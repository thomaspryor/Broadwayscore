// BRO-4753 — shared title guard for the closing-date audits
// (scripts/lib/show-title-match.js), required from the real lib (CLAUDE.md §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { pageMatchesShowTitle } = require('../../scripts/lib/show-title-match.js');
const discovery = require('../../scripts/lib/closing-date-discovery.js');
const we = require('../../scripts/lib/we-closing-date-extract.js');

const SCHOOL_GIRLS = 'School Girls; Or, The African Mean Girls Play';

test('a 404 whose inline JS says "display" does not confirm a title ending in "Play"', () => {
  const html = '<html><script>el.style.display = "none"; var x = "display copy";</script><h1>Page not found</h1></html>';
  assert.equal(pageMatchesShowTitle(html, SCHOOL_GIRLS), false);
});

test('substrings never count, whole words do', () => {
  assert.equal(pageMatchesShowTitle('<p>Our displays and replays</p>', 'The Play'), false);
  assert.equal(pageMatchesShowTitle('<p>Tickets for School Girls on Broadway</p>', SCHOOL_GIRLS), true);
});

test('generic words alone do not confirm a title that has distinctive words', () => {
  assert.equal(pageMatchesShowTitle('<p>Book a Broadway play tonight</p>', SCHOOL_GIRLS), false);
});

test('all-generic and short titles still match on their own words', () => {
  assert.equal(pageMatchesShowTitle('<p>The Play That Goes Wrong... the play</p>', 'The Play'), true);
  assert.equal(pageMatchesShowTitle('<p>Job is a thriller</p>', 'Job'), true);
  assert.equal(pageMatchesShowTitle('<p>Jobs board</p>', 'Job'), false);
});

test('apostrophes and punctuation in page text still match', () => {
  assert.equal(pageMatchesShowTitle("<p>Hell's Kitchen extends</p>", "Hell's Kitchen"), true);
  assert.equal(pageMatchesShowTitle('<p>OH, MARY! at the Lyceum</p>', 'Oh, Mary!'), true);
});

test('all three closing-date guards use the shared function', () => {
  assert.equal(discovery.pageMatchesShowTitle, pageMatchesShowTitle);
  assert.equal(we.pageMatchesShowTitle, pageMatchesShowTitle);
  const src = readFileSync(new URL('../../scripts/audit-closing-dates.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/show-title-match'\)/);
  assert.doesNotMatch(src, /function pageMatchesShow\(/);
});
