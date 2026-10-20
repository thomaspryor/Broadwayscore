import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { orphanFilesAfterNulling } = require('./image-null-orphan-files.js');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inof-'));
  fs.mkdirSync(path.join(root, 'public'));
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x'); }
  return path.join(root, 'public');
}
const act = (o, n) => ({ type: 'data-edit', file: 'shows.json', showId: 'petra-off-broadway-2026', field: 'images', oldValue: o, newValue: n });

test('flags files that pre-deploy-check would re-attach after a null-out (BRO-5739)', () => {
  const pub = repo(['public/images/shows/petra-off-broadway-2026/thumbnail.jpg', 'public/images/shows/petra-off-broadway-2026/poster.jpg']);
  const a = act({ thumbnail: '/x/thumbnail.jpg', poster: '/x/poster.jpg', hero: null }, { thumbnail: null, poster: null, hero: null });
  assert.deepEqual(orphanFilesAfterNulling(a, pub), ['public/images/shows/petra-off-broadway-2026/thumbnail.jpg', 'public/images/shows/petra-off-broadway-2026/poster.jpg']);
});

test('nothing flagged once the files are gone, for kept fields, or for other actions', () => {
  const pub = repo(['public/images/shows/petra-off-broadway-2026/poster.jpg']);
  assert.deepEqual(orphanFilesAfterNulling(act({ thumbnail: '/x', poster: '/y' }, { thumbnail: null, poster: '/y' }), pub), []);
  assert.deepEqual(orphanFilesAfterNulling(act({ thumbnail: '/x' }, { thumbnail: null }), repo([])), []);
  // a field that was already null still gets re-filled from disk, so a leftover file is flagged
  assert.deepEqual(orphanFilesAfterNulling(act({ thumbnail: null, poster: null }, { thumbnail: null, poster: null }), repo(['public/images/shows/petra-off-broadway-2026/poster.jpg'])), ['public/images/shows/petra-off-broadway-2026/poster.jpg']);
  assert.deepEqual(orphanFilesAfterNulling({ type: 'review-field-edit' }, pub), []);
  assert.deepEqual(orphanFilesAfterNulling({ ...act({ thumbnail: '/x' }, { thumbnail: null }), showId: '../etc' }, pub), []);
});
