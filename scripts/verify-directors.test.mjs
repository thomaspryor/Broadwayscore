/**
 * BRO-4993 data check: model-path director credits re-verified by hand.
 * Reads the live core data (data/shows.json), so it passes only once plan
 * data/pending-fixes/bro-4993.json has been applied. Not in the unit glob.
 *   node --test scripts/verify-directors.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isValidCreativeTeamName } = require('./lib/ibdb-dates.js');
const raw = require('../data/shows.json');
const shows = Array.isArray(raw) ? raw : raw.shows;
const byId = new Map(shows.map(s => [s.id, s]));

const directorsOf = (s) => (s.creativeTeam || []).filter(c => /^director$/i.test(c.role)).map(c => c.name);

test('no creative credit is a placeholder ("TBA", "N/A", "unknown", "An")', () => {
  const bad = [];
  for (const s of shows) for (const c of s.creativeTeam || []) {
    if (!isValidCreativeTeamName(c.name)) bad.push(`${s.id}: ${c.role} "${c.name}"`);
  }
  assert.deepEqual(bad, []);
});

const EXPECTED = {
  'the-receptionist-off-broadway-2026': 'Sarah Benson',
  'end-of-the-rainbow-west-end-2026': 'Rupert Hands',
  'what-happened-was-off-broadway-2026': 'Ian Rickson',
  'the-comedy-about-spies-west-end-2026': 'Matt DiCarlo',
  'a-walk-on-the-moon-off-broadway-2026': 'Sheryl Kaller',
  'the-last-ship-off-broadway-2026': 'Leo Warner',
  'the-people-versus-lenny-bruce-off-broadway-2026': 'Antony Marsellis',
  'a-few-good-men-2026': 'Michael Arden',
  'the-sound-of-music-2027': 'Lear deBessonet',
  'book-of-mormon-tour-2022': 'Jennifer Werner',
  'waitress-tour-2026': "Abbey O'Brien",
  'water-for-elephants-tour-2025': 'Ryan Emmons',
  'hadestown-tour-2024': 'Keenan Tyler Oliphant',
  'the-wiz-tour-2026': 'Schele Williams',
  'spamalot-tour-2025': 'Josh Rhodes',
  'kinky-boots-tour-2025': 'DB Bonds',
};

for (const [id, name] of Object.entries(EXPECTED)) {
  test(`${id} is directed by ${name}`, (t) => {
    const s = byId.get(id);
    if (!s) return t.skip(`${id} not in shows.json`);
    assert.deepEqual(directorsOf(s), [name]);
  });
}

test('hershey-felder-the-piano-and-me credits no director', (t) => {
  const s = byId.get('hershey-felder-the-piano-and-me-off-broadway-2026');
  if (!s) return t.skip('not in shows.json');
  assert.deepEqual(directorsOf(s), []);
});
