import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { findShowIdFolderMismatches } = createRequire(import.meta.url)('./review-showid-folder.js');

test('finds records whose showId disagrees with the folder, skips _ dirs and matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7996-'));
  const w = (d, f, o) => { fs.mkdirSync(path.join(root, d), { recursive: true }); fs.writeFileSync(path.join(root, d, f), JSON.stringify(o)); };
  w('show-a-2025', 'ok.json', { showId: 'show-a-2025' });
  w('show-a-2025', 'bad.json', { showId: 'show-a-2026', publishDate: '2025-05-14' });
  w('show-a-2025', 'wp.json', { showId: 'show-b', wrongProduction: true });
  w('_pending', 'x.json', { showId: 'zzz' });
  const r = findShowIdFolderMismatches(root);
  assert.deepEqual(r.map(x => x.file).sort(), ['bad.json', 'wp.json']);
  assert.equal(r.find(x => x.file === 'wp.json').wrongProduction, true);
});

test('live data: no live (non-wrongProduction) showId/folder mismatches', { skip: !process.env.REVIEW_TEXTS_DIR }, () => {
  const live = findShowIdFolderMismatches(process.env.REVIEW_TEXTS_DIR).filter(x => !x.wrongProduction);
  assert.equal(live.length, 0, JSON.stringify(live.slice(0, 5)));
});
