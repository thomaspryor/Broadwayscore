// Tests for the Olivier ceremony-page nominee parser (BRO-4851). The fixture
// is verbatim wikitext from "2025 Laurence Olivier Awards" (fetched 2026-10-07).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseOlivierCeremonyNominees } = require('./olivier-ceremony-wikipedia.js');

const WIKITEXT_2025 = `!width="50%" |[[Laurence Olivier Award for Best New Play|Best New Play]]
|-
|valign="top" |
*'''''[[Giant (play)|Giant]]'' by [[Mark Rosenblatt]] – [[Royal Court Theatre|Jerwood Downstairs, Royal Court]]'''
**''[[The Fear of 13 (play)|The Fear of 13]]'' by [[Lindsey Ferrentino]] (based on original film by [[David Sington]]) – [[Donmar Warehouse]]
**''[[Kyoto (play)|Kyoto]]'' by Joe Murphy and Joe Robertson – [[@sohoplace]]
**''[[Benedict Lombe|Shifters]]'' by [[Benedict Lombe]] – [[Duke of York's Theatre]]
**''[[The Years (play)|The Years]]'' adapted by [[Eline Arbo]] and translated by Stephanie Bain (based on original text by [[Annie Ernaux]]) – [[Almeida Theatre]] and [[Harold Pinter Theatre]]
|valign="top" |
**''[[MJ the Musical]]'' – [[Prince Edward Theatre]]
**''[[Natasha, Pierre & The Great Comet of 1812|Natasha, Pierre and the Great Comet of 1812]]'' – [[Donmar Warehouse]]
**''[[The Importance of Being Earnest]]'' – [[Royal National Theatre|National Theatre Lyttelton]]
`;

test('parses title + venue from ceremony nominee lines', () => {
  const rows = parseOlivierCeremonyNominees(WIKITEXT_2025);
  const byTitle = Object.fromEntries(rows.map(r => [r.title, r.venues]));
  assert.deepEqual(byTitle['Kyoto'], ['@sohoplace']);
  assert.deepEqual(byTitle['MJ the Musical'], ['Prince Edward Theatre']);
  assert.deepEqual(byTitle['The Importance of Being Earnest'], ['National Theatre Lyttelton']);
});

test('uses the link DISPLAY text, not the article name', () => {
  const rows = parseOlivierCeremonyNominees(WIKITEXT_2025);
  assert.ok(rows.some(r => r.title === 'Shifters'), 'Shifters links to its author article');
  assert.ok(rows.some(r => r.title === 'Natasha, Pierre and the Great Comet of 1812'));
});

test('keeps apostrophes in venue names (only strips wiki italic/bold quote runs)', () => {
  const rows = parseOlivierCeremonyNominees(WIKITEXT_2025);
  assert.deepEqual(rows.find(r => r.title === 'Shifters').venues, ["Duke of York's Theatre"]);
});

test('splits transfers listed as "X and Y" into two venues', () => {
  const rows = parseOlivierCeremonyNominees(WIKITEXT_2025);
  assert.deepEqual(rows.find(r => r.title === 'The Years').venues, ['Almeida Theatre', 'Harold Pinter Theatre']);
});

test('the winner line (bold-italic wrapper) parses like a nominee', () => {
  const rows = parseOlivierCeremonyNominees(WIKITEXT_2025);
  assert.deepEqual(rows.find(r => r.title === 'Giant').venues, ['Jerwood Downstairs', 'Royal Court']);
});

test('hyphen separator and {{double dagger}} templates leave clean venue names', () => {
  const rows = parseOlivierCeremonyNominees([
    "**''[[The Great Gatsby]]'' - [[London Coliseum]]",
    "*'''''[[Inter Alia]]'' – [[Royal National Theatre|National Theatre Lyttelton]]{{double dagger|alt=Winner}}'''",
  ].join('\n'));
  assert.deepEqual(rows.find(r => r.title === 'The Great Gatsby').venues, ['London Coliseum']);
  assert.deepEqual(rows.find(r => r.title === 'Inter Alia').venues, ['National Theatre Lyttelton']);
});

test('ignores non-list lines and empty input', () => {
  assert.deepEqual(parseOlivierCeremonyNominees(''), []);
  assert.deepEqual(parseOlivierCeremonyNominees('|valign="top" |\n!Header'), []);
});
