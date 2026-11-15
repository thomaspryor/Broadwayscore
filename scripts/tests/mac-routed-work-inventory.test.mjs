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
