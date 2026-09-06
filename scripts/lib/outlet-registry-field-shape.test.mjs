import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outletFieldShapeErrors } = require('./outlet-registry-field-shape.js');

test('an omitted starScale is how "no star scale" is spelled — no error', () => {
  const entry = { displayName: 'The Arbuturian', tier: 3, domain: 'arbuturian.com' };
  assert.deepEqual(outletFieldShapeErrors('arbuturian', entry), []);
});

test('starScale: null is still rejected — present is present', () => {
  const errors = outletFieldShapeErrors('arbuturian', { starScale: null });
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
});

// The regression this module exists for. Test Suite run 34003135401 went red on
// a single `"starScale": null`, and the message told the author to pick one of
// 4/5/10/100 — the one thing they must NOT do for an outlet with no star scale.
// Assert the message names the actual remedy, not just that it fires.
test('the starScale: null message tells the author to OMIT the key', () => {
  const [message] = outletFieldShapeErrors('arbuturian', { starScale: null });
  assert.match(message, /OMIT the key/,
    `the null message must name the fix, got: ${message}`);
});

test('a non-null bad starScale does NOT get the omit advice — inventing 7 is a different mistake', () => {
  const [message] = outletFieldShapeErrors('somewhere', { starScale: 7 });
  assert.doesNotMatch(message, /OMIT the key/,
    `only null means "no star scale"; got: ${message}`);
  assert.match(message, /must be one of 4, 5, 10, 100/);
});

test('a string starScale is rejected even when it looks like a legal value', () => {
  const errors = outletFieldShapeErrors('somewhere', { starScale: '5' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /starScale="5"/);
});

test('every legal starScale passes', () => {
  for (const scale of [4, 5, 10, 100]) {
    assert.deepEqual(outletFieldShapeErrors('x', { starScale: scale }), [],
      `starScale ${scale} must be accepted`);
  }
});

test('multiAuthor must be boolean, and both booleans pass', () => {
  assert.deepEqual(outletFieldShapeErrors('x', { multiAuthor: true }), []);
  assert.deepEqual(outletFieldShapeErrors('x', { multiAuthor: false }), []);
  const errors = outletFieldShapeErrors('x', { multiAuthor: 'yes' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a boolean/);
});

test('both fields wrong reports both, so one fix does not mask the other', () => {
  const errors = outletFieldShapeErrors('x', { starScale: null, multiAuthor: 'yes' });
  assert.equal(errors.length, 2, `expected both, got ${JSON.stringify(errors)}`);
});

test('a non-object entry is skipped rather than throwing', () => {
  assert.deepEqual(outletFieldShapeErrors('x', null), []);
  assert.deepEqual(outletFieldShapeErrors('x', 'not-an-object'), []);
});

// Wiring. Every test above passes just as happily if someone deletes the CALL
// in validate-data.js and leaves the require — v39's defect-11 shape, verified
// by doing exactly that. validate-data.js pins DATA_DIR to __dirname/../data
// with no override, so there is no seam to spawn it against a fixture registry
// without writing to the real one; this reads the source instead. Stated
// plainly so it is not mistaken for a behavioural test: it proves the call site
// exists and that no divergent copy of the rule has grown back beside it, and
// nothing more.
test('validate-data.js actually calls the extracted check (call site, not just the require)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await readFile(path.join(here, '..', 'validate-data.js'), 'utf8');

  assert.match(src, /require\('\.\/lib\/outlet-registry-field-shape'\)/,
    'validate-data.js must require the extracted module');
  assert.match(src, /outletFieldShapeErrors\(/,
    'validate-data.js must CALL outletFieldShapeErrors — a require alone validates nothing');
  assert.doesNotMatch(src, /ALLOWED_STAR_SCALES\s*=\s*new Set/,
    'the allowed-scale set must live only in the extracted module; a second copy here is how the two drift apart');
});
