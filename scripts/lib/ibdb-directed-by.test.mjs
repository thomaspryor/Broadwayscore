// BRO-5080: "Directed by" matched mid-credit, so "Originally directed by Harold
// Prince" put the 1970 Company's director on the 2021 revival, and "Movement
// directed by" credits became Director credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractCreativeTeamFromText } = require('./ibdb-dates.js');
const directors = (t) => extractCreativeTeamFromText(t).filter((m) => m.role === 'Director').map((m) => m.name);

test('a prefixed "directed by" credit is not this production\'s director', () => {
  assert.deepEqual(directors('Directed by Marianne Elliott; Originally directed by Harold Prince'), ['Marianne Elliott']);
  assert.deepEqual(directors('Directed by Peter Wood; Movement directed by William Chappell'), ['Peter Wood']);
});

test('a plain "Directed by" credit anywhere in the list still counts', () => {
  assert.deepEqual(directors('Directed by Bartlett Sher'), ['Bartlett Sher']);
  assert.deepEqual(directors('Book by A Writer; Directed by Gedalia Besser; Choreographed by C Person'), ['Gedalia Besser']);
  assert.deepEqual(directors('Written by Sharr White\nDirected by Bartlett Sher'), ['Bartlett Sher']);
  assert.deepEqual(directors('Music by Jule Styne Directed by Jerome Robbins'), ['Jerome Robbins']);
  assert.deepEqual(directors('Entire production directed by George Abbott'), ['George Abbott']);
  assert.deepEqual(directors('Original production directed by Moss Hart; Directed by Howard Davies'), ['Howard Davies']);
  assert.deepEqual(directors('Fight directed by B. H. Barry; Directed by Jane Roe'), ['Jane Roe']);
});

// BRO-5088: Good Evening (1973) listed Joe McGrath, who directed the film
// sequences, as a second Director.
test('film-sequence and similar partial-direction credits are not the director', () => {
  assert.deepEqual(directors('Directed by Jerry Adler; Film Sequences Directed by Joe McGrath'), ['Jerry Adler']);
  assert.deepEqual(directors('Directed by Jerry Adler; Vocal directed by A Person'), ['Jerry Adler']);
});

test('other partial-direction credits are not the director; flattened film-adaptation text still is', () => {
  assert.deepEqual(directors('Directed by A Lead; Music Directed by Ted Sperling'), ['A Lead']);
  assert.deepEqual(directors('Directed by A Lead; Puppetry directed by Basil Twist; Video directed by Z Person'), ['A Lead']);
  assert.deepEqual(directors('Based on the film Directed by Jane Roe'), ['Jane Roe']);
});
