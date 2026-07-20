/**
 * Regression test for the West End venue-alias table.
 *
 * Motivation: WE long-runner CV hardening card 34c637c5-416f-812b issue #2.
 * CV flagged legitimate pre-rename reviews as wrongProduction because
 * shows.json held the CURRENT venue name but old reviews said the OLD name.
 *
 * Run: node --test tests/unit/venue-aliases.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  VENUE_ALIASES,
  getVenueAliases,
  findCanonical,
  hasAliases,
  buildVenueContext,
} = require('../../scripts/lib/venue-aliases.js');

test('Her Majesty\'s → His Majesty\'s alias is registered', () => {
  const entry = getVenueAliases("His Majesty's Theatre");
  assert.ok(entry, 'His Majesty\'s Theatre must have aliases');
  assert.ok(entry.aliases.includes("Her Majesty's Theatre"));
  assert.match(entry.note, /2022/, 'note must explain when the rename happened');
});

test('Queen\'s ↔ Sondheim alias is registered (Les Mis WE case)', () => {
  const entry = getVenueAliases('Sondheim Theatre');
  assert.ok(entry);
  assert.ok(entry.aliases.includes("Queen's Theatre"));
});

test('findCanonical maps an old name to the current name', () => {
  assert.equal(findCanonical("Her Majesty's Theatre"), "His Majesty's Theatre");
  assert.equal(findCanonical("Queen's Theatre"), 'Sondheim Theatre');
  assert.equal(findCanonical('New London Theatre'), 'Gillian Lynne Theatre');
  assert.equal(findCanonical('Globe Theatre'), 'Gielgud Theatre');
});

test('findCanonical passes through unknown venues unchanged', () => {
  assert.equal(findCanonical('Apollo Theatre'), 'Apollo Theatre');
  assert.equal(findCanonical('Broadway Theatre'), 'Broadway Theatre');
  assert.equal(findCanonical('Some Made-Up Name'), 'Some Made-Up Name');
});

test('findCanonical is case + punctuation tolerant', () => {
  assert.equal(findCanonical("HER MAJESTY'S THEATRE"), "His Majesty's Theatre");
  // Curly apostrophe from rich-text sources must also match
  assert.equal(findCanonical('Her Majesty’s Theatre'), "His Majesty's Theatre");
});

test('hasAliases flags renamed venues only', () => {
  assert.equal(hasAliases("His Majesty's Theatre"), true);
  assert.equal(hasAliases('Apollo Theatre'), false);
  assert.equal(hasAliases(null), false);
  assert.equal(hasAliases(''), false);
});

test('buildVenueContext expands the renamed venue into a self-documenting string', () => {
  const ctx = buildVenueContext("His Majesty's Theatre");
  assert.match(ctx, /His Majesty's Theatre/);
  assert.match(ctx, /formerly known as/i);
  assert.match(ctx, /Her Majesty's Theatre/);
  assert.match(ctx, /2022/, 'expansion must include date context so LLM understands why review says old name');
});

test('buildVenueContext returns plain venue when no aliases registered', () => {
  assert.equal(buildVenueContext('Apollo Theatre'), 'Apollo Theatre');
  assert.equal(buildVenueContext('National Theatre'), 'National Theatre');
});

test('buildVenueContext handles empty / null gracefully', () => {
  assert.equal(buildVenueContext(null), '');
  assert.equal(buildVenueContext(''), '');
  assert.equal(buildVenueContext(undefined), '');
});

test('alias table entries have the required shape', () => {
  for (const [canonical, entry] of Object.entries(VENUE_ALIASES)) {
    assert.ok(Array.isArray(entry.aliases), `${canonical}: aliases must be an array`);
    assert.ok(entry.aliases.length > 0, `${canonical}: must have at least one alias`);
    assert.ok(typeof entry.note === 'string' && entry.note.length > 0,
      `${canonical}: must have an explanatory note`);
    for (const alias of entry.aliases) {
      assert.notEqual(alias, canonical, `${canonical}: alias must differ from canonical`);
    }
  }
});

test('all 11 renamed Broadway theaters from broadway-theaters.js have alias entries', () => {
  // Prevention: any theater later marked .renamed in broadway-theaters.js must
  // get a VENUE_ALIASES entry, or the CV wrongProduction FP class returns
  // (333 pre-rename shows, venue-anachronism audit 2026-07-13).
  const { BROADWAY_THEATERS } = require('../../scripts/lib/broadway-theaters.js');
  for (const [key, t] of Object.entries(BROADWAY_THEATERS)) {
    if (!t.renamed) continue;
    const entry = getVenueAliases(t.canonical, 'broadway');
    assert.ok(entry, `${key} (${t.canonical}) is renamed but has no VENUE_ALIASES entry`);
    assert.equal(entry.region, 'nyc', `${key}: renamed Broadway house must be region nyc`);
    assert.match(entry.note, /\d{4}/, `${key}: note must include rename date context`);
  }
});

test('Broadway rename context reaches the CV prompt (king-hedley Virginia case)', () => {
  const ctx = buildVenueContext('August Wilson Theatre', 'broadway');
  assert.match(ctx, /Virginia Theatre/);
  assert.match(ctx, /2005/);
});

test('same-name venues do not cross regions (the two Lyric Theatres)', () => {
  // Broadway Lyric (ex-Foxwoods/Hilton/Ford Center) must expand for Broadway…
  assert.match(buildVenueContext('Lyric Theatre', 'broadway'), /Foxwoods/);
  // …but a London Lyric (Shaftesbury Ave) show must NOT get Broadway history.
  assert.equal(buildVenueContext('Lyric Theatre', 'west-end'), 'Lyric Theatre');
  // And the London Sondheim (ex-Queen's) stays distinct from Stephen Sondheim.
  assert.match(buildVenueContext('Sondheim Theatre', 'west-end'), /Queen's/);
  assert.equal(getVenueAliases('Sondheim Theatre', 'broadway'), null);
});

test('market-less lookups keep legacy behavior (match any region)', () => {
  assert.match(buildVenueContext("His Majesty's Theatre"), /Her Majesty's/);
  assert.match(buildVenueContext('Lena Horne Theatre'), /Brooks Atkinson/);
});

test('off-market variants map to the same region', () => {
  assert.match(buildVenueContext("His Majesty's Theatre", 'off-west-end'), /Her Majesty's/);
  assert.match(buildVenueContext('James Earl Jones Theatre', 'off-broadway'), /Cort/);
});

test('content-verifier imports venue-aliases without breaking', () => {
  // Sanity check: the wiring change in scripts/lib/content-verifier.js must
  // not blow up at require time. verifyContent() itself needs API keys +
  // network for a real call, but the module load is testable.
  const cv = require('../../scripts/lib/content-verifier.js');
  assert.ok(typeof cv.verifyContent === 'function');
});
