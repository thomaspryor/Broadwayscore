import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stagedTitle } = require('./staged-title.js');

test('BRO-7270: shouted 4-word title is converted', () => {
  assert.equal(stagedTitle('little-bear-ridge-road-regional-2027', 'LITTLE BEAR RIDGE ROAD').title, 'Little Bear Ridge Road');
});
test('already-cased and short stylised titles are untouched', () => {
  assert.equal(stagedTitle('x', 'Little Bear Ridge Road').title, 'Little Bear Ridge Road');
  assert.equal(stagedTitle('six', 'SIX').title, 'SIX');
});
test('stage script uses the helper for the emitted title', () => {
  const src = fs.readFileSync(new URL('../city-finder-stage.js', import.meta.url), 'utf8');
  assert.match(src, /title: stagedTitleLogged\(id, p\.title\)/);
});
