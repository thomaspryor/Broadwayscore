/**
 * BRO-5848: shows.json principal-cast rules (scripts/lib/cast-principals.js),
 * tested against the real functions (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractCast } = require('./cast-principals.js');

const names = r => (r || []).map(m => m.name);

test('a lone "Performer" beside crew roles is kept (The Picture of Dorian Gray, 2025)', () => {
  const cast = {
    openingNightCast: [
      { name: 'Sarah Snook', role: 'Performer', flags: ['Broadway debut'] },
      { name: 'clew', role: 'Camera Operator' },
      { name: 'Luka Kain', role: 'Camera Operator' },
      { name: 'Natalie Rich', role: 'Camera Operator' },
      { name: 'Benjamin Sheen', role: 'Camera Operator' },
      { name: 'Dara Woo', role: 'Camera Operator' },
    ],
  };
  assert.deepEqual(names(extractCast(cast, 'closed', 15))[0], 'Sarah Snook');
});

test('a real ensemble in a big cast is still filtered out', () => {
  const cast = {
    openingNightCast: [
      { name: 'Lead One', role: 'Roxie Hart' },
      { name: 'Lead Two', role: 'Velma Kelly' },
      { name: 'E1', role: 'Ensemble' },
      { name: 'E2', role: 'Ensemble' },
      { name: 'E3', role: 'Ensemble' },
      { name: 'S1', role: 'Swing' },
    ],
  };
  assert.deepEqual(names(extractCast(cast, 'closed', 15)), ['Lead One', 'Lead Two']);
});

test('a lone swing or lone "Ensemble"/"Female Ensemble" credit is never a principal', () => {
  const cast = {
    openingNightCast: [
      { name: 'A', role: 'Hamlet' }, { name: 'B', role: 'Ophelia' }, { name: 'C', role: 'Laertes' },
      { name: 'D', role: 'Horatio' }, { name: 'E', role: 'Gertrude' }, { name: 'Sw', role: 'Swing' },
      { name: 'En', role: 'Ensemble' }, { name: 'Fe', role: 'Female Ensemble' },
    ],
  };
  assert.deepEqual(names(extractCast(cast, 'closed', 15)), ['A', 'B', 'C', 'D', 'E']);
});

test('uniform generic role (revue) keeps everyone; small casts keep generic labels', () => {
  const revue = { openingNightCast: Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, role: 'Performer' })) };
  assert.equal(extractCast(revue, 'closed', 15).length, 8);
  const solo = { openingNightCast: [{ name: 'Daniel Radcliffe', role: 'Performer' }] };
  assert.deepEqual(extractCast(solo, 'closed', 15), [{ name: 'Daniel Radcliffe', role: 'Narrator' }]);
});

test('stars who alternated a role stay when they played it on opening night (The Little Foxes, 2017)', () => {
  const cast = {
    openingNightCast: [
      { name: 'Laura Linney', role: 'Regina Giddens', flags: ['Played Regina on opening night', 'Alternate'] },
      { name: 'Cynthia Nixon', role: 'Birdie Hubbard', flags: ['Played Birdie on opening night', 'Alternate'] },
      { name: 'Richard Thomas', role: 'Horace Giddens' },
      { name: 'Plain Alt', role: 'Horace Giddens', flags: ['Alternate'] },
    ],
  };
  assert.deepEqual(names(extractCast(cast, 'closed', 15)), ['Laura Linney', 'Cynthia Nixon', 'Richard Thomas']);
});

test('open shows read currentCast; understudies and alternates drop; cap applies', () => {
  const cast = {
    currentCast: [
      { name: 'Now Lead', role: 'Frank' },
      { name: 'Cover', role: 'Understudy for Frank' },
      { name: 'Alt', role: 'Frank', flags: ['Alternate'] },
      { name: 'Two', role: 'Janet' },
    ],
    openingNightCast: [{ name: 'Opening Lead', role: 'Frank' }],
  };
  assert.deepEqual(names(extractCast(cast, 'open', 15)), ['Now Lead', 'Two']);
  assert.deepEqual(names(extractCast(cast, 'closed', 15)), ['Opening Lead']);
  assert.deepEqual(names(extractCast(cast, 'open', 1)), ['Now Lead']);
  assert.equal(extractCast({}, 'closed', 15), null);
});
