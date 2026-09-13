// Regression tests for BRO-3191 (2026-09-12/13): two same-title West End
// shows got discovered a second time under a different slug/venue string and
// were never recognized as duplicates, splitting real critic reviews (or
// rendering a dead second page) until manually deleted — twice, because
// discover-new-shows.js kept re-adding them on its next run.
//
// Case 1 — Electra/Persona: "Electra/Persona" (no spaces) slugified/
// normalized differently from "Electra / Persona" (spaced) because a bare
// "/" was dropped instead of treated as a word separator.
// Case 2 — As You Like It: title matched fine, but "Globe Theatre" and
// "Shakespeare's Globe" (the same physical venue) were never aliased, so
// isMultiProduction() treated the pair as confirmed-different-venue and let
// it through as a legitimate second production.
//
// Per feedback_test_extraction_pattern.md: require the real functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { slugify, normalizeTitle, checkForDuplicate } = require('../../scripts/lib/deduplication.js');

test('slugify treats a bare "/" as a word separator, same as a spaced one', () => {
  assert.equal(slugify('Electra/Persona'), slugify('Electra / Persona'));
  assert.equal(slugify('Electra/Persona'), 'electra-persona');
});

test('normalizeTitle treats a bare "/" as a word separator, same as a spaced one', () => {
  assert.equal(normalizeTitle('Electra/Persona'), normalizeTitle('Electra / Persona'));
  assert.equal(normalizeTitle('Electra/Persona'), 'electra persona');
});

test('Electra/Persona re-discovery is caught as a duplicate (BRO-3191 repro)', () => {
  const existing = { id: 'electra-persona-west-end-2026', title: 'Electra / Persona', slug: 'electra-persona-west-end', venue: 'National Theatre', previewsStartDate: '2026-08-19', status: 'open', category: 'west-end' };
  const candidate = { id: 'electrapersona-west-end-2026', title: 'Electra/Persona', slug: 'electrapersona-west-end', venue: 'Lyttelton Theatre', previewsStartDate: '2026-08-19', status: 'previews', category: 'west-end' };
  const result = checkForDuplicate(candidate, [existing]);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.existingShow.id, existing.id);
});

test('As You Like It / Globe Theatre re-discovery is caught as a duplicate (BRO-3191 repro)', () => {
  const existing = { id: 'as-you-like-it-globe-west-end-2026', title: 'As You Like It', slug: 'as-you-like-it-globe-west-end', venue: "Shakespeare's Globe", previewsStartDate: '2026-08-14', status: 'open', category: 'west-end' };
  const candidate = { id: 'as-you-like-it-globe-off-west-end-2026', title: 'As You Like It - Globe', slug: 'as-you-like-it-globe-off-west-end', venue: 'Globe Theatre', previewsStartDate: '2026-08-14', status: 'previews', category: 'off-west-end' };
  const result = checkForDuplicate(candidate, [existing]);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.existingShow.id, existing.id);
});

test('Sam Wanamaker Playhouse (Globe indoor stage) is NOT aliased onto Globe Theatre/Shakespeare\'s Globe', () => {
  const { aliasCanonical } = require('../../scripts/lib/deduplication.js');
  assert.notEqual(aliasCanonical('Sam Wanamaker Playhouse'), aliasCanonical('Globe Theatre'));
  assert.notEqual(aliasCanonical('Sam Wanamaker Playhouse'), aliasCanonical("Shakespeare's Globe"));
});

test('genuinely different Globe-venue productions still do not collide (title differs)', () => {
  const muchAdo = { id: 'much-ado-about-nothing-globe-off-west-end-2026', title: 'Much Ado About Nothing', slug: 'much-ado-about-nothing-globe-off-west-end', venue: 'Globe Theatre', previewsStartDate: '2026-05-01', status: 'open', category: 'off-west-end' };
  const asYouLikeIt = { id: 'as-you-like-it-globe-west-end-2026', title: 'As You Like It', slug: 'as-you-like-it-globe-west-end', venue: "Shakespeare's Globe", previewsStartDate: '2026-08-14', status: 'open', category: 'west-end' };
  assert.equal(checkForDuplicate(muchAdo, [asYouLikeIt]).isDuplicate, false);
});
