// BRO-7734 / Sentry 7812256534: "Invalid regular expression: invalid group specifier name"
// is a lookbehind `(?<!` / `(?<=` parsed by Safari < 16.4. Client code must not contain one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFloorQuote } from '../../src/lib/box-office-status.ts';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no regex lookbehind in src/ (literal, string or template), ships to old Safari', () => {
  const bad = [];
  for (const f of walk('src')) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\(\?<[=!]/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('hasFloorQuote keeps the old lookbehind behaviour', () => {
  assert.equal(hasFloorQuote('capitalized at over $20 million'), true);
  assert.equal(hasFloorQuote('at least $5 million'), true);
  assert.equal(hasFloorQuote('Rolled over $5 million from last year'), false);
  assert.equal(hasFloorQuote('carried over $5 million'), false);
  assert.equal(hasFloorQuote('more than turned over $5'), false);
  assert.equal(hasFloorQuote('a budget of $5 million'), false);
});
