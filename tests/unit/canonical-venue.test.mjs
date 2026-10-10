import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalVenue } = require('../../scripts/lib/title-match.js');

test('canonicalVenue: collapses Signature Center variants', () => {
  // Multiple companies + sub-stages all map to one key
  assert.equal(canonicalVenue('Signature Theatre'), 'signature center');
  assert.equal(canonicalVenue('Pershing Square Signature Center'), 'signature center');
  assert.equal(canonicalVenue('The Irene Diamond Stage at the Pershing Square Signature Center'), 'signature center');
  assert.equal(canonicalVenue('Romulus Linney Courtyard Theatre'), 'signature center');
  assert.equal(canonicalVenue('The New Group'), 'signature center');
  assert.equal(canonicalVenue('Ford Foundation New Works Theater'), 'signature center');
});

test('canonicalVenue: distinguishes Second Stage Uptown vs Hayes', () => {
  assert.equal(canonicalVenue('Second Stage Uptown'), 'second stage uptown');
  assert.equal(canonicalVenue('McGinn/Cazale Theater'), 'second stage uptown');
  assert.equal(canonicalVenue('Hayes Theater'), 'second stage hayes');
  assert.equal(canonicalVenue('Second Stage Theater - Hayes'), 'second stage hayes');
  assert.notEqual(canonicalVenue('Second Stage Uptown'), canonicalVenue('Hayes Theater'));
});

test('canonicalVenue: Atlantic stages distinguished', () => {
  assert.equal(canonicalVenue('Atlantic Theater'), 'atlantic theater');
  assert.equal(canonicalVenue('Atlantic Theater Company - Linda Gross Theater'), 'atlantic theater');
  assert.equal(canonicalVenue('Atlantic Stage 2'), 'atlantic stage 2');
  assert.notEqual(canonicalVenue('Atlantic Theater'), canonicalVenue('Atlantic Stage 2'));
});

test('canonicalVenue: MCC sub-stages collapsed', () => {
  assert.equal(canonicalVenue('MCC Theater'), 'mcc theater');
  assert.equal(canonicalVenue('MCC Theater – Newman Mills Theater'), 'mcc theater');
  assert.equal(canonicalVenue('The Newman Mills Theatre at the Robert W. Wilson MCC Theatre Space'), 'mcc theater');
});

test('canonicalVenue: TFANA + Polonsky synonyms', () => {
  assert.equal(canonicalVenue('Theatre for a New Audience'), 'tfana');
  assert.equal(canonicalVenue('Polonsky Shakespeare Center'), 'tfana');
  assert.equal(canonicalVenue('TFANA'), 'tfana');
});

test('canonicalVenue: Irish Rep variations', () => {
  assert.equal(canonicalVenue('Irish Repertory Theatre'), 'irish rep');
  assert.equal(canonicalVenue('Irish Rep'), 'irish rep');
});

test('canonicalVenue: Soho Rep + Vineyard simple', () => {
  assert.equal(canonicalVenue('Soho Rep'), 'soho rep');
  assert.equal(canonicalVenue('Vineyard Theatre'), 'vineyard theatre');
});

test('canonicalVenue: unknown venue falls back to first-word', () => {
  // Legacy behavior — no alias hit → first word lowercase
  assert.equal(canonicalVenue('Acme Theater'), 'acme');
  assert.equal(canonicalVenue('Westside Theatre - Upstairs'), 'westside');
});

test('canonicalVenue: empty/null safe', () => {
  assert.equal(canonicalVenue(''), '');
  assert.equal(canonicalVenue(null), '');
  assert.equal(canonicalVenue(undefined), '');
  assert.equal(canonicalVenue('   '), '');
});

test('canonicalVenue: The New Group dedups against Signature (P0 from second-opinion)', () => {
  // The pre-mortem case: TNG renting Signature Center
  const tngKey = canonicalVenue('The New Group');
  const sigKey = canonicalVenue('Pershing Square Signature Center');
  const sigKey2 = canonicalVenue('Signature Theatre');
  assert.equal(tngKey, sigKey, 'TNG must dedupe against Pershing Square');
  assert.equal(tngKey, sigKey2, 'TNG must dedupe against Signature Theatre');
});

test('Atlantic company-form Stage 2 does not collapse onto mainstage alias', () => {
  assert.equal(canonicalVenue('Atlantic Theater Company Stage 2'), 'atlantic stage 2');
  assert.equal(canonicalVenue('Atlantic Stage 2'), 'atlantic stage 2');
  assert.equal(canonicalVenue('Atlantic Theater Company'), 'atlantic theater');
  assert.equal(canonicalVenue('Linda Gross Theater'), 'atlantic theater');
});
