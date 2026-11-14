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

// BRO-6945: NYC buildings, real shows.json venue strings.
test('NYC stages resolve to their building (real venue strings)', () => {
  const cases = [
    ['Vivian Beaumont Theater', 'Lincoln Center Theater'], ['Lincoln Center Theater - Mitzi E. Newhouse Theater', 'Lincoln Center Theater'],
    ['Mitzi E. Newhouse Theatre', 'Lincoln Center Theater'], ['LCT3 at the Claire Tow Theater', 'Lincoln Center Theater'],
    ['The Public Theater – LuEsther Hall', 'The Public Theater'], ['Public Theater/Newman Theater', 'The Public Theater'],
    ['Martinson Theater at Joseph Papp Public Theater', 'The Public Theater'], ['Public Theater/Delacorte Theater', 'The Public Theater'],
    ['The Irene Diamond Stage at the Pershing Square Signature Center', 'Pershing Square Signature Center'],
    ['The Pershing Square Signature Center/Alice Griffin Jewel Box Theatre', 'Pershing Square Signature Center'],
    ['The Romulus Linney Courtyard Theatre at The Pershing Square Signature Center', 'Pershing Square Signature Center'],
    ['Atlantic Theater Company - Linda Gross Theater', 'Atlantic Theater Company'], ['Atlantic Stage 2', 'Atlantic Theater Company'],
    ['Atlantic Theater Company/Stage 2', 'Atlantic Theater Company'],
    ['MCC Theater – Newman Mills Theater', 'Robert W. Wilson MCC Theater Space'],
    ['Susan & Ronald Frankel Theater at the Robert W. Wilson MCC Theatre Space - NYC', 'Robert W. Wilson MCC Theater Space'],
    ['The Griffin Theater at The Shed', 'The Shed'],
  ];
  for (const [venue, parent] of cases) assert.equal(parentBuildingOf(venue, 'broadway')?.parent, parent, venue);
});

test('NYC buildings themselves and unrelated venues are not stages; London unaffected', () => {
  for (const v of ['The Public Theater', 'Public Theater', 'Pershing Square Signature Center', 'Signature Center', 'Atlantic Theater Company',
    'MCC Theater', 'The Shed', 'Lincoln Center Theater', 'Second Stage Theater/Tony Kiser Theater', 'New York City Center – Stage II',
    'The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre', 'Signature Theatre, Arlington, VA', 'Marriott Theatre, Lincolnshire, IL'])
    assert.equal(parentBuildingOf(v, 'broadway'), null, v);
  assert.equal(parentBuildingOf('Vivian Beaumont Theater', 'west-end'), null);
  assert.equal(parentBuildingOf('Vivian Beaumont Theater', 'regional'), null);
  assert.equal(parentBuildingOf('Olivier Theatre', 'west-end')?.parent, 'National Theatre');
});

test('NYC reverse lookup lists all stages; note does not list venue as its own other stage', () => {
  assert.equal(stagesOfBuilding('The Public Theater', 'off-broadway').length, 7);
  assert.deepEqual(stagesOfBuilding('Lincoln Center Theater', 'broadway').length, 3);
  const n = buildParentBuildingNote('Vivian Beaumont Theater', 'broadway');
  assert.match(n, /one stage inside Lincoln Center Theater/);
  assert.doesNotMatch(n, /other stages:.*Vivian/);
});

test('NYC note never lists the venue itself as an other stage (theater/theatre spelling), Gene Frankel is not MCC', () => {
  for (const v of ['Mitzi E. Newhouse Theatre', 'The Pershing Square Signature Center/Alice Griffin Jewel Box Theatre', 'Atlantic Theater Company/Stage 2', 'Martinson Theater at Joseph Papp Public Theater', 'The Griffin Theater at The Shed']) {
    const p = parentBuildingOf(v, 'broadway');
    const m = buildParentBuildingNote(v, 'broadway').match(/other stages: (.*)\)\. A review/);
    assert.ok(p && m, v);
    const own = p.stages.filter((s) => !m[1].split(', ').includes(s));
    assert.equal(own.length, 1, `${v}: exactly one stage (itself) omitted, got ${own}`);
  }
  assert.equal(parentBuildingOf('Gene Frankel Theater', 'off-broadway'), null);
});
