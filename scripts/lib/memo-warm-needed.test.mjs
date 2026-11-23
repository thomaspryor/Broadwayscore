// BRO-8148 class guard: a landing that changes a fingerprint-memo key file must warm the memo on main,
// and every workflow's memo cache key must cover all files the memo versions on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { memoKeyFiles, needsWarm } = require('./memo-warm-needed.js');
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const wfDir = path.join(root, '.github', 'workflows');

test('needsWarm is true for every memo key file and false for unrelated files', () => {
  const keys = memoKeyFiles();
  assert.ok(keys.includes('scripts/lib/text-cleaning.js') && keys.includes('scripts/lib/trailer-signatures.js'));
  for (const k of keys) assert.equal(needsWarm([k]), true, k);
  assert.equal(needsWarm(['src/app/page.tsx', 'data/shows.json', 'scripts/lib/other.js']), false);
  assert.equal(needsWarm([]), false);
});

test('every workflow memo cache key hashes ALL files the memo versions on', () => {
  const keys = memoKeyFiles();
  let seen = 0;
  for (const f of fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const text = fs.readFileSync(path.join(wfDir, f), 'utf8');
    for (const m of text.matchAll(/rebuild-fp-memo-v1-\$\{\{\s*hashFiles\(([^)]*)\)/g)) {
      seen++;
      for (const k of keys) assert.ok(m[1].includes(`'${k}'`), `${f}: memo key hashFiles misses ${k}`);
    }
  }
  assert.ok(seen >= 5, `expected several memo keys, saw ${seen}`);
});

test('land.yml warms the memo after a landing that touched a key file', () => {
  const land = fs.readFileSync(path.join(wfDir, 'land.yml'), 'utf8');
  const i = land.indexOf('name: Warm the fingerprint memo');
  assert.ok(i > 0, 'land.yml has no "Warm the fingerprint memo" step');
  const body = land.slice(i, i + 2500);
  assert.match(body, /steps\.land\.outputs\.landed == 'true'/);
  assert.match(body, /memo-warm-needed\.js/);
  assert.match(body, /rebuild-fast\.yml --ref main/);
  assert.match(body, /MEMO_WARM_DISABLED/);
});
