// BRO-6923: a show filed at a stage inside a bigger building must not have its
// reviews rejected because the critic names the building.
// Run: node --test scripts/lib/venue-parent-building.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const va = require('./venue-aliases.js');
const { parentBuildingOf, stagesOfBuilding, buildParentBuildingNote, buildVenueContext, findCanonical } = va;

test('stages resolve to their parent building', () => {
  const cases = [
    ['The Maria Theatre', 'Young Vic'], ['The Clare', 'Young Vic'], ['Young Vic (Main House)', 'Young Vic'],
    ['Lyttelton Theatre', 'National Theatre'], ['Olivier Theatre', 'National Theatre'], ['Dorfman', 'National Theatre'],
    ['National Theatre (Olivier)', 'National Theatre'], ['Dorfman (Cottesloe)', 'National Theatre'],
    ['Sam Wanamaker Playhouse', "Shakespeare's Globe"], ['Hampstead Theatre Downstairs', 'Hampstead Theatre'],
    ['Soho Theatre Upstairs', 'Soho Theatre'], ['The Other Palace - Studio', 'The Other Palace'],
    ['Jerwood Theatre Downstairs', 'Royal Court Theatre'],
  ];
  for (const [venue, parent] of cases) assert.equal(parentBuildingOf(venue, 'off-west-end')?.parent, parent, venue);
});

test('the building itself, other sites and unrelated venues are not stages', () => {
  for (const v of ['National Theatre', 'Young Vic', 'Soho Theatre Walthamstow', 'Soho Theatre', 'Gielgud Theatre', 'Royal Court', 'Shakespeare\'s Globe', null, ''])
    assert.equal(parentBuildingOf(v), null, String(v));
});

test('reverse lookup of a parent returns ALL stages, never one', () => {
  const nt = stagesOfBuilding('National Theatre');
  assert.deepEqual(nt.sort(), ['Dorfman Theatre', 'Lyttelton Theatre', 'Olivier Theatre']);
  assert.deepEqual(stagesOfBuilding('Lyttelton Theatre'), []);
  assert.deepEqual(stagesOfBuilding('Nope'), []);
});

test('region filter: Broadway venues never pick up London buildings', () => {
  assert.equal(parentBuildingOf('Olivier Theatre', 'broadway'), null);
  assert.equal(parentBuildingOf('Olivier Theatre', 'west-end')?.parent, 'National Theatre');
});

test('findCanonical is unchanged for parents and stages (no single stage chosen)', () => {
  assert.equal(findCanonical('National Theatre'), 'National Theatre');
  assert.equal(findCanonical('Lyttelton Theatre'), 'Lyttelton Theatre');
  assert.equal(findCanonical("Her Majesty's Theatre"), "His Majesty's Theatre");
});

test('prompt context tells the verifier the building name is not a different venue', () => {
  const c = buildVenueContext('The Maria Theatre', 'off-west-end');
  assert.match(c, /one stage inside Young Vic/);
  assert.match(c, /NOT by itself evidence/);
  assert.match(buildParentBuildingNote('National Theatre', 'west-end'), /Lyttelton Theatre, Olivier Theatre, Dorfman Theatre|several stages/);
  assert.equal(buildParentBuildingNote('Gielgud Theatre', 'west-end'), '');
  // alias rename context still wins for renamed houses
  assert.match(buildVenueContext("His Majesty's Theatre", 'west-end'), /Her Majesty's/);
});

test('generic stage names do not match other London venues; note does not list the venue as its own other stage', () => {
  assert.equal(parentBuildingOf('Nottingham Playhouse Main House'), null);
  assert.equal(parentBuildingOf('Jerwood Vanbrugh Theatre'), null);
  assert.equal(parentBuildingOf('Young Vic (Main House)', 'off-west-end')?.parent, 'Young Vic');
  assert.equal(parentBuildingOf('Royal Court Jerwood Theatre Upstairs')?.parent, 'Royal Court Theatre');
  const n = buildParentBuildingNote('The Maria Theatre', 'off-west-end');
  assert.match(n, /other stages: The Clare, Main House\)/);
  assert.match(buildParentBuildingNote('Dorfman (Cottesloe)', 'west-end'), /other stages: Lyttelton Theatre, Olivier Theatre\)/);
});

test('Other Palace studio does not list itself; National Theatre of Scotland is not the National Theatre', () => {
  assert.match(buildParentBuildingNote('The Other Palace - Studio', 'off-west-end'), /other stages: The Other Palace Main Auditorium\)/);
  assert.deepEqual(stagesOfBuilding('National Theatre of Scotland'), []);
});
