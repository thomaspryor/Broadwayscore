// Regression tests for the discovery exclude-substring audit (BRO-181).
//
// audit-regex-patterns.js --full audits content-quality.js regex families
// against review text, but the discovery exclude arrays in
// scripts/discover-new-shows.js (NON_THEATER_PATTERNS, WE_EXTRA_PATTERNS,
// VENUE_PAGE_EXCLUDE_PATTERNS) got no corpus audit — those arrays gate which
// candidate shows ever reach shows.json, so a false-positive substring there
// silently drops a real production from discovery. Two confirmed FP classes:
// bare 'gala' matched "Via Galactica" (fixed 2026-07-31), and bare
// 'quartet'/'tour' plus the 'classic penguins' entry matched real tracked
// shows (fixed 2026-08-26, this task). These tests pin both fixes and the
// scan/evaluate machinery that catches the next one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TITLE_EXCLUDE_FAMILIES,
  TITLE_EXCLUDE_DEFAULT_MAX_HITS,
  loadTitleExcludeFamilies,
  scanTitleFamilies,
  evaluateTitleFamilies,
} = require('./audit-regex-patterns.js');
const {
  NON_THEATER_PATTERNS,
  WE_EXTRA_PATTERNS,
  VENUE_PAGE_EXCLUDE_PATTERNS,
} = require('./discover-new-shows.js');

test('discover-new-shows.js exports all three title exclude families', () => {
  assert.deepEqual(TITLE_EXCLUDE_FAMILIES, [
    'NON_THEATER_PATTERNS',
    'WE_EXTRA_PATTERNS',
    'VENUE_PAGE_EXCLUDE_PATTERNS',
  ]);
  const families = loadTitleExcludeFamilies();
  assert.ok(Array.isArray(families.NON_THEATER_PATTERNS) && families.NON_THEATER_PATTERNS.length > 0);
  assert.ok(Array.isArray(families.WE_EXTRA_PATTERNS));
  assert.ok(Array.isArray(families.VENUE_PAGE_EXCLUDE_PATTERNS) && families.VENUE_PAGE_EXCLUDE_PATTERNS.length > 0);
});

test('default allowance for title exclude families is 0 (any hit is a confirmed FP)', () => {
  assert.equal(TITLE_EXCLUDE_DEFAULT_MAX_HITS, 0);
});

test('scanTitleFamilies + evaluateTitleFamilies flag a bare substring against a real title', () => {
  const families = { TEST_FAMILY: ['gala', 'spring gala'] };
  const titles = ['Via Galactica', 'Spring Gala Benefit', 'Hamilton'];
  const counts = scanTitleFamilies({ families, titles });
  assert.equal(counts.TEST_FAMILY[0].hits, 2, 'bare "gala" matches both Via Galactica and Spring Gala Benefit');
  assert.equal(counts.TEST_FAMILY[1].hits, 1, '"spring gala" only matches the benefit listing');

  const violations = evaluateTitleFamilies({ counts });
  assert.equal(violations.length, 2, 'both patterns exceed the 0-hit default allowance');
  assert.equal(violations[0].family, 'TEST_FAMILY');
  assert.equal(violations[0].hits, 2);
});

test('scanTitleFamilies + evaluateTitleFamilies pass clean when patterns only match noise titles', () => {
  const families = { TEST_FAMILY: ['spring gala', 'masterclass'] };
  const titles = ['Hamilton', 'Wicked', 'Some Other Show'];
  const counts = scanTitleFamilies({ families, titles });
  const violations = evaluateTitleFamilies({ counts });
  assert.equal(violations.length, 0);
});

// Pins the 2026-07-31 fix: 'gala' was narrowed to multi-word variants
// specifically because the bare word matched "Via Galactica" (1972 Broadway
// show, still in the corpus as a historical entry).
test('gala FP fix: no NON_THEATER_PATTERNS/VENUE_PAGE_EXCLUDE_PATTERNS entry is the bare word "gala"', () => {
  const allGalaEntries = [...NON_THEATER_PATTERNS, ...VENUE_PAGE_EXCLUDE_PATTERNS].filter(p => p.includes('gala'));
  assert.ok(allGalaEntries.length > 0, 'expected multi-word gala variants to still be present');
  for (const p of allGalaEntries) {
    assert.notEqual(p, 'gala', 'bare "gala" must not be reintroduced — matches "Via Galactica"');
  }
  assert.equal('Via Galactica'.toLowerCase().includes('gala') && allGalaEntries.includes('gala'), false);
});

// Pins the 2026-08-26 (BRO-181) fixes found by extending the audit to these
// arrays: bare 'quartet' matched "Million Dollar Quartet", bare 'tour'
// matched "Armory Public Tours" / "September L. Davis: The Apology Tour",
// and 'classic penguins' matched a since-legitimized tracked show.
test('BRO-181 FP fixes: known-collision patterns are absent, real titles are not matched', () => {
  assert.ok(!NON_THEATER_PATTERNS.includes('quartet'), 'bare "quartet" must not be reintroduced — matches "Million Dollar Quartet"');
  assert.ok(NON_THEATER_PATTERNS.includes('quintet'), 'quintet has no confirmed corpus collision, should remain');
  assert.ok(!VENUE_PAGE_EXCLUDE_PATTERNS.includes('tour'), 'bare "tour" must not be reintroduced — matches "Armory Public Tours"');
  assert.ok(VENUE_PAGE_EXCLUDE_PATTERNS.includes('walking tour'), 'walking tour variant covers the literal backstage-tour case');
  assert.ok(!WE_EXTRA_PATTERNS.includes('classic penguins'), '"classic penguins" must not be reintroduced — now a tracked real show');

  const realTitles = [
    'Million Dollar Quartet',
    'Armory Public Tours',
    'September L. Davis: The Apology Tour',
    'Garry Starr: Classic Penguins',
  ];
  const families = loadTitleExcludeFamilies();
  const counts = scanTitleFamilies({ families, titles: realTitles });
  const violations = evaluateTitleFamilies({ counts });
  assert.equal(violations.length, 0,
    `expected no violations against known-real titles, got: ${JSON.stringify(violations)}`);
});
