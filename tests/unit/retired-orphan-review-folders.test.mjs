// BRO-5897: orphan review folders that belong to a retired show id. Requires the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findOrphanReviewFolders, retiredOrphanFolders } = require('../../scripts/lib/orphan-review-folders.js');

test('a retired id with review files is reported; one holding only sidecars is not; live and unregistered differ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-orphans-'));
  const put = (folder, file) => { fs.mkdirSync(path.join(dir, folder), { recursive: true }); fs.writeFileSync(path.join(dir, folder, file), '{}'); };
  put('anon-retired', 'nytimes--helen-shaw.json');
  put('sidecar-only-retired', '_blocklist.json');
  put('unregistered-orphan', 'vulture--x.json');
  put('live-show', 'nytimes--y.json');
  const orphans = findOrphanReviewFolders(dir, new Set(['live-show']));
  const retired = [{ id: 'anon-retired', duplicateOf: 'anon-kept' }, { id: 'sidecar-only-retired' }];
  const hit = retiredOrphanFolders(orphans, retired);
  assert.deepEqual(hit.map((o) => o.folder), ['anon-retired']);
  assert.equal(hit[0].retired.duplicateOf, 'anon-kept');
  assert.deepEqual(retiredOrphanFolders(orphans, []), []);
});
