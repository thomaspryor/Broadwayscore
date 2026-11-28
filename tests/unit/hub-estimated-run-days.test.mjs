// BRO-7239 / BRO-7108: the run-length constant must match between script and page logic (reads src/ only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('ESTIMATED_RUN_DAYS matches between script and page logic', async () => {
  const { createRequire } = await import('node:module');
  const js = createRequire(import.meta.url)('../../scripts/lib/run-end-from-text.js').ESTIMATED_RUN_DAYS;
  const ts = fs.readFileSync('src/lib/city-hub.ts', 'utf8').match(/ESTIMATED_RUN_DAYS = (\d+)/)[1];
  assert.equal(String(js), ts);
});
