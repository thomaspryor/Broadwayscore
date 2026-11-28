import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('pending replay loads each show once and reuses it for the opera check', () => {
  const source = readFileSync(new URL('../../scripts/replay-pending-bylines.js', import.meta.url), 'utf8');
  const processShow = source.slice(source.indexOf('async function processShow('), source.indexOf('\nasync function ', source.indexOf('async function processShow(') + 1));
  assert.equal((processShow.match(/\bloadShow\s*\(/g) || []).length, 1);
  assert.match(processShow, /operaHouseForVenue\(\(show\s*\|\|\s*\{\}\)\.venue\)/);
});
