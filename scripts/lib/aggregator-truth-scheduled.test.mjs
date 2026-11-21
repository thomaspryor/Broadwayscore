import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// BRO-7931 #5 class guard: the committed aggregator-truth files must have a scheduled writer.
const wfDir = new URL('../../.github/workflows/', import.meta.url).pathname;
const scheduled = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml'))
  .map(f => fs.readFileSync(path.join(wfDir, f), 'utf8')).filter(t => /^\s*schedule:/m.test(t));
test('build-aggregator-truth.js runs inside a scheduled workflow', () => {
  assert.ok(scheduled.some(t => t.includes('scripts/build-aggregator-truth.js')));
});
