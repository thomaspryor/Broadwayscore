// BRO-6140: model false negatives split into diagnosed / undiagnosed / stale.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { splitModelFalseNegatives, MODEL_FALSE_NEGATIVE_EXPLANATIONS } = require('../../scripts/lib/model-false-negative-explanations');

const fn = { recouped: true, modelRecouped: false };

test('a diagnosed false negative is explained, an unknown one is not', () => {
  const r = splitModelFalseNegatives([['known', fn], ['new-show', fn]], { known: 'type-default cost', gone: 'old note' });
  assert.deepEqual(r.explained, [{ key: 'known', why: 'type-default cost' }]);
  assert.deepEqual(r.unexplained, ['new-show']);
  assert.deepEqual(r.staleExplanations, ['gone']);
});

test('only recouped:true with modelRecouped:false counts', () => {
  const r = splitModelFalseNegatives([
    ['agree', { recouped: true, modelRecouped: true }],
    ['unknown-model', { recouped: true, modelRecouped: null }],
    ['loss', { recouped: false, modelRecouped: false }],
    ['tbd', { recouped: null, modelRecouped: false }],
    ['empty', null],
  ], { agree: 'now fixed' });
  assert.deepEqual(r.unexplained, []);
  assert.deepEqual(r.explained, []);
  assert.deepEqual(r.staleExplanations, ['agree']);
});

test('the shipped list is frozen and every diagnosis says something', () => {
  assert.ok(Object.isFrozen(MODEL_FALSE_NEGATIVE_EXPLANATIONS));
  for (const [key, why] of Object.entries(MODEL_FALSE_NEGATIVE_EXPLANATIONS)) {
    assert.match(key, /^[a-z0-9-]+$/, key);
    assert.ok(typeof why === 'string' && why.length >= 40, `${key} needs a real diagnosis`);
  }
});
