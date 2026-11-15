import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = fs.readFileSync(path.join(root, 'scripts', 'launchd', 'MAC-ROUTED-WORK.md'), 'utf8');
const plists = fs.readdirSync(path.join(root, 'scripts', 'launchd')).filter((f) => f.endsWith('.plist')).map((f) => f.replace(/\.plist$/, ''));

test('every launchd job has a needs-Mac / cloud-capable verdict in scripts/launchd/MAC-ROUTED-WORK.md (BRO-7554)', () => {
  assert.ok(plists.length > 0);
  const missing = [];
  for (const p of plists) {
    const row = doc.split('\n').find((l) => l.startsWith(`| ${p} |`));
    if (!row || !/\|\s*(needs-Mac|cloud-capable)\s*\|/.test(row)) missing.push(p);
  }
  assert.deepEqual(missing, [], `add a verdict row for: ${missing.join(', ')}`);
});

test('a "moved" row has no plist and a real workflow; no row names a deleted plist (BRO-7573)', () => {
  const rows = doc.split('\n').filter((l) => /^\| com\.(broadwayscore|bwsc)\./.test(l));
  const bad = [];
  for (const row of rows) {
    const name = row.split('|')[1].trim();
    const verdict = row.split('|')[2].trim();
    if (verdict === 'moved') {
      const wf = path.join(root, '.github', 'workflows', `${name.replace(/^com\.(broadwayscore|bwsc)\./, '')}.yml`);
      if (plists.includes(name)) bad.push(`${name}: moved but plist still present`);
      if (!fs.existsSync(wf)) bad.push(`${name}: moved but ${path.basename(wf)} missing`);
    } else if (!plists.includes(name)) {
      bad.push(`${name}: row has no plist (deleted? remove the row or mark moved)`);
    }
  }
  assert.deepEqual(bad, []);
});
