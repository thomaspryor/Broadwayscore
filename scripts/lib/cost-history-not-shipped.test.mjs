// BRO-5604: costHistory (dated Waltz anchors, ~1,400 rows) must stay offline.
// src/lib/data-commercial.ts is the only reader of commercial.json for pages;
// it strips costHistory before the guarded copy every page and client prop reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('data-commercial strips costHistory from the page copy', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/lib/data-commercial.ts'), 'utf8');
  assert.match(src, /costHistory:\s*_costHistory/, 'data-commercial.ts must destructure costHistory away');
});

// data-tony-predictions reads only `designation` from it, server-side.
const ALLOWED = ['src/lib/data-commercial.ts', 'src/lib/data-tony-predictions.ts'];

test('no other src file imports commercial.json directly', () => {
  const offenders = walk(path.join(REPO, 'src'))
    .filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
    .filter((f) => /from\s+['"][^'"]*data\/commercial\.json['"]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'a second reader of commercial.json would ship costHistory');
});
