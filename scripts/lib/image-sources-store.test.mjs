// BRO-4901: a corrupt image-sources.json must not load as {} (the next save would wipe it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadImageSources, saveImageSources, recordImageSource, IMAGE_SOURCES_PATH } = require('./image-sources-store.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'imgsrc-'));

test('missing file loads as {}, corrupt file throws', () => {
  const d = tmpDir();
  assert.deepEqual(loadImageSources(path.join(d, 'none.json')), {});
  fs.writeFileSync(path.join(d, 'bad.json'), '{"funny-girl-2002": {"poster": "htt');
  assert.throws(() => loadImageSources(path.join(d, 'bad.json')), SyntaxError);
});

test('save round-trips and leaves no temp file', () => {
  const d = tmpDir();
  const f = path.join(d, 'image-sources.json');
  const map = { 'waiting-for-godot-2013': { poster: 'manual:original-run art (checked by eye, BRO-4901)', hero: null } };
  saveImageSources(map, f);
  assert.deepEqual(loadImageSources(f), map);
  assert.deepEqual(fs.readdirSync(d), ['image-sources.json']);
});

test('the real map loads', () => {
  if (!fs.existsSync(IMAGE_SOURCES_PATH)) return;
  assert.ok(Object.keys(loadImageSources()).length > 1000);
});

test('recordImageSource sets only the named formats and keeps other rows', () => {
  const d = tmpDir();
  const f = path.join(d, 'image-sources.json');
  saveImageSources({ 'la-boheme-met-2025': { poster: 'https://old/p.jpg', hero: 'https://old/h.jpg' }, 'other': { poster: 'x' } }, f);
  recordImageSource('la-boheme-met-2025', ['poster', 'thumbnail'], 'https://new/a.jpg', f);
  assert.deepEqual(loadImageSources(f), {
    'la-boheme-met-2025': { poster: 'https://new/a.jpg', hero: 'https://old/h.jpg', thumbnail: 'https://new/a.jpg' },
    other: { poster: 'x' },
  });
});
