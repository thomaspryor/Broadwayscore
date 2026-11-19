// BRO-7734 / Sentry 7812256534: "Invalid regular expression: invalid group specifier name"
// is a lookbehind `(?<!` / `(?<=` parsed by Safari < 16.4. Client code must not contain one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no regex lookbehind or named group in src/ (ships to old Safari)', () => {
  const bad = [];
  for (const f of walk('src')) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\/[^/\n]*\(\?<[=!A-Za-z][^/\n]*\/[gimsuy]*/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('hasFloorQuote keeps the old lookbehind behaviour', async () => {
  const src = fs.readFileSync('src/lib/box-office-status.ts', 'utf8');
  const m = src.match(/const NOT_A_FLOOR_RE = (.*);\nconst FLOOR_QUOTE_RE = (.*);/);
  assert.ok(m, 'regex constants found');
  const not = eval(m[1]); const floor = eval(m[2]);
  const has = (t) => floor.test(t.replace(not, ' '));
  assert.equal(has('capitalized at over $20 million'), true);
  assert.equal(has('at least $5 million'), true);
  assert.equal(has('Rolled over $5 million from last year'), false);
  assert.equal(has('carried over $5 million'), false);
  assert.equal(has('a budget of $5 million'), false);
});
