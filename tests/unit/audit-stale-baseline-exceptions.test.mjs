import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { audit, findPermanentLabels } = require('../../scripts/lib/audit-stale-baseline-exceptions.js');

test('flags permanence language in baseline entry strings', () => {
  const hits = findPermanentLabels({ entries: [{ file: 'a.js', note: 'permanent real-time-critical sender' }], n: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, '$.entries[0].note');
});

test('catches common phrasings', () => {
  for (const s of ['Stays in baseline until BRO-1 migrates', 'kept indefinitely', "won't fix", 'permanent_exception']) {
    assert.equal(findPermanentLabels({ n: s }).length, 1, s);
  }
});

test('catches enum slugs, camelCase and keys (BRO-5261 retro-review)', () => {
  for (const s of ['permanent', 'permanent-exception', 'kept-forever', 'permanentException', 'remains in baseline until migrated', 'intentionally exempt']) {
    assert.equal(findPermanentLabels({ n: s }).length, 1, s);
  }
  assert.equal(findPermanentLabels({ permanent: ['scripts/a.js'] }).length, 1);
  assert.equal(findPermanentLabels({ impermanent_cache: 1 }).length, 0);
});

test('ignores show ids and URLs that contain the word', () => {
  assert.deepEqual(findPermanentLabels({ ids: ['on-a-clear-day-you-can-see-forever-2011'], u: 'https://x.com/permanent-collection', f: 'scripts/forever.js' }), []);
});

test('does not flag ordinary baseline text', () => {
  assert.deepEqual(findPermanentLabels({ description: 'Frozen list of known-bad archives', files: { 'x.js': 2 } }), []);
});

test('the repo baselines carry no permanent-exception labels', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { files, findings, unreadable } = audit(root);
  assert.ok(files.length >= 10, 'expected to scan the tracked baseline files');
  assert.deepEqual(findings, []);
  // A merge-broken or missing baseline must not pass as "skipped".
  assert.deepEqual(unreadable, []);
});
