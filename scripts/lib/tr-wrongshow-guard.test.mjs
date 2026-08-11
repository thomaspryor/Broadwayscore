import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkWrongShowGuard } = require('./tr-wrongshow-guard.js');

test('multi-word distinctive title passes on a single mention', () => {
  const text = 'A fine revival of Juno and the Paycock at the Gielgud, with Mark Rylance in fine form.';
  const r = checkWrongShowGuard(text, 'Juno and the Paycock');
  assert.equal(r.pass, true);
  assert.equal(r.corroborated, false);
});

test('common-word (city name) title rejects without corroboration', () => {
  // Real Barcelona review shape: outlet reviews the play but rarely repeats
  // the one-word title "Barcelona" more than once or twice.
  const text = 'Lily Collins and Alvaro Morte spark in this two-hander about a hookup gone wrong. The play is tense and well-acted throughout its 90 minutes.';
  const r = checkWrongShowGuard(text, 'Barcelona', { outletId: 'guardian', wetOutletIds: new Set() });
  assert.equal(r.pass, false);
  assert.match(r.skipReason, /wrong-show/);
});

test('common-word title with WET corroboration for the outlet passes', () => {
  const text = 'Lily Collins and Alvaro Morte spark in this two-hander about a hookup gone wrong. The play is tense and well-acted throughout its 90 minutes.';
  const r = checkWrongShowGuard(text, 'Barcelona', {
    outletId: 'guardian',
    wetOutletIds: new Set(['guardian', 'financialtimes', 'thestage', 'standard', 'times-uk']),
  });
  assert.equal(r.pass, true);
  assert.equal(r.corroborated, true);
});

test('common-word title with WET corroboration for a DIFFERENT outlet still rejects', () => {
  const text = 'Lily Collins and Alvaro Morte spark in this two-hander about a hookup gone wrong. The play is tense and well-acted throughout its 90 minutes.';
  const r = checkWrongShowGuard(text, 'Barcelona', {
    outletId: 'daily-mail',
    wetOutletIds: new Set(['guardian', 'financialtimes']),
  });
  assert.equal(r.pass, false);
});

test('no outletId/wetOutletIds context still evaluates the raw mention count', () => {
  const text = 'SIX brings queens to life eight times over in this Tudor pop concert. SIX is a triumph of pop-concert theatre.';
  const r = checkWrongShowGuard(text, 'SIX');
  assert.equal(r.pass, true);
});

test('short single-word title needs 2+ mentions even with corroboration absent', () => {
  const text = 'A pleasant enough evening at the theatre, though nothing special.';
  const r = checkWrongShowGuard(text, 'Cats');
  assert.equal(r.pass, false);
  assert.equal(r.minMentions, 2);
});
