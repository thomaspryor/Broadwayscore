// Regression tests for the Check 6 slug-prefix containment rule in
// scripts/lib/deduplication.js. Per feedback_test_extraction_pattern.md:
// require the real functions, don't reimplement.
//
// Incident (2026-06-12): Shakespeare in the Park's "ROMEO AND JULIET"
// (Delacorte, opened 2026-06-11) was dropped by discovery because
// "romeo-and-juliet" is a slug prefix of "romeo-and-juliet-suite-off-broadway"
// (the Park Avenue Armory dance piece). Containment is only duplicate
// evidence when the longer slug's remainder is non-content (market/year
// suffix or subtitle filler), not a content word like "suite".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSlugContainmentDuplicate, checkForDuplicate } = require('../../scripts/lib/deduplication.js');

test('content-word remainder is NOT a duplicate (SitP incident)', () => {
  assert.equal(isSlugContainmentDuplicate('romeo-and-juliet', 'romeo-and-juliet-suite-off-broadway'), false);
  assert.equal(isSlugContainmentDuplicate('hamlet-x', 'hamlet-x-hail-to-the-thief'), false);
});

test('mid-word prefix is NOT a duplicate (hyphen boundary required)', () => {
  assert.equal(isSlugContainmentDuplicate('anne', 'annette-bening-live'), false);
});

test('market/year/subtitle-filler remainders ARE duplicates', () => {
  assert.equal(isSlugContainmentDuplicate('death-becomes-her', 'death-becomes-her-the-musical'), true);
  assert.equal(isSlugContainmentDuplicate('six-the-musical', 'six-the-musical-off-broadway-2026'), true);
  assert.equal(isSlugContainmentDuplicate('wicked', 'wicked-2003'), true);
  assert.equal(isSlugContainmentDuplicate('the-outsiders', 'the-outsiders-a-new-musical'), true);
  // Bare "play"/"musical" disambiguators (TodayTix "A Doll's House (Play)")
  assert.equal(isSlugContainmentDuplicate('a-dolls-house', 'a-dolls-house-play-off-west-end'), true);
  assert.equal(isSlugContainmentDuplicate('a-dolls-house', 'a-dolls-house'), true);
});

test('checkForDuplicate accepts SitP Romeo and Juliet against the Suite show', () => {
  const existing = [{
    id: 'romeo-and-juliet-suite-off-broadway-2026',
    title: 'Romeo & Juliet Suite',
    slug: 'romeo-and-juliet-suite-off-broadway',
    venue: 'Park Avenue Armory',
    category: 'off-broadway',
    status: 'closed',
    openingDate: '2026-03-02',
  }];
  const candidate = {
    title: 'ROMEO AND JULIET',
    venue: 'The Public Theater/Delacorte Theater',
    category: 'off-broadway',
    openingDate: '2026-06-11',
    previewsStartDate: '2026-05-22',
  };
  const r = checkForDuplicate(candidate, existing);
  assert.equal(r.isDuplicate, false, `should not be a duplicate, got: ${r.reason}`);
});

test('checkForDuplicate still flags a true re-listing of the same show', () => {
  const existing = [{
    id: 'romeo-and-juliet-suite-off-broadway-2026',
    title: 'Romeo & Juliet Suite',
    slug: 'romeo-and-juliet-suite-off-broadway',
    venue: 'Park Avenue Armory',
    category: 'off-broadway',
    status: 'open',
  }];
  const r = checkForDuplicate(
    { title: 'Romeo & Juliet Suite', venue: 'Park Avenue Armory', category: 'off-broadway' },
    existing
  );
  assert.equal(r.isDuplicate, true);
});

test('compound Playbill venue (Company/Theater) still matches bare house name — stays duplicate', () => {
  // P0 regression (2026-06-12 ship-check): threading real Playbill venues onto
  // candidates must not flip isMultiProduction's different-venue escape for
  // catalog twins that store only the house name.
  const existing = [{
    id: 'thornton-wilders-the-emporium-off-broadway-2026',
    title: "Thornton Wilder's The Emporium",
    slug: 'thornton-wilders-the-emporium-off-broadway',
    venue: 'Lynn F. Angelson Theater',
    category: 'off-broadway',
    status: 'announced',
    openingDate: '2026-05-18',
  }];
  const r = checkForDuplicate({
    title: "THORNTON WILDER'S THE EMPORIUM",
    venue: 'Classic Stage Company/Lynn F. Angelson Theater',
    openingDate: '2026-05-18',
    category: 'off-broadway',
  }, existing);
  assert.equal(r.isDuplicate, true, 'compound venue must not read as a different venue');
});

test('genuinely different venues still escape as separate productions', () => {
  const existing = [{
    id: 'romeo-and-juliet-suite-off-broadway-2026',
    title: 'Romeo & Juliet Suite',
    slug: 'romeo-and-juliet-suite-off-broadway',
    venue: 'Park Avenue Armory',
    category: 'off-broadway',
    status: 'closed',
    openingDate: '2026-03-02',
  }];
  const r = checkForDuplicate({
    title: 'ROMEO AND JULIET',
    venue: 'The Public Theater/Delacorte Theater',
    openingDate: '2026-06-11',
    category: 'off-broadway',
  }, existing);
  assert.equal(r.isDuplicate, false);
});
