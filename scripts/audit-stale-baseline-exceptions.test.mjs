import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { audit, findPermanentLabels } = require('./audit-stale-baseline-exceptions.js');

test('flags permanence language in baseline entry strings', () => {
  const hits = findPermanentLabels({ entries: [{ file: 'a.js', note: 'permanent real-time-critical sender' }], n: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, '$.entries[0].note');
});

test('does not flag ordinary baseline text', () => {
  assert.deepEqual(findPermanentLabels({ description: 'Frozen list of known-bad archives', files: { 'x.js': 2 } }), []);
});

test('the repo baselines carry no permanent-exception labels', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { files, findings } = audit(root);
  assert.ok(files.length >= 10, 'expected to scan the tracked baseline files');
  assert.deepEqual(findings, []);
});
