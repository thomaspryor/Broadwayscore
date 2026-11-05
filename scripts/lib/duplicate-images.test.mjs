/**
 * Tests for scripts/lib/duplicate-images.js (BRO-4393)
 * Run: node --test scripts/lib/duplicate-images.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const {
  DUPLICATE_IMAGE_ALLOWLIST, titleKey, findDuplicateImageGroups, hashShowImageFiles, auditDuplicateImages,
  findLookalikeImageGroups, signatureShowImageFiles, LOOKALIKE_MIN_SIMILARITY,
} = require('./duplicate-images.js');
const imagePhash = require('./image-phash.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const f = (showId, hash, key = 'thumbnail') => ({ showId, key, path: `/images/shows/${showId}/${key}.jpg`, hash });

test('flags byte-identical art on unrelated shows (the Illinoise / Hell\'s Kitchen case)', () => {
  const shows = [{ id: 'illinoise-2024', title: 'Illinoise' }, { id: 'hells-kitchen-2024', title: "Hell's Kitchen" }];
  const groups = findDuplicateImageGroups([f('illinoise-2024', 'h1'), f('hells-kitchen-2024', 'h1'), f('illinoise-2024', 'h2', 'poster')], shows, { allowlist: [], sharedAllowlist: {} });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['hells-kitchen-2024', 'illinoise-2024']);
  assert.equal(groups[0].hash, 'h1');
  assert.equal(groups[0].files.length, 2);
});

test('same title ignoring accents, case, punctuation and "(YYYY)" is one show', () => {
  assert.equal(titleKey('Les Misérables'), titleKey('Les Miserables'));
  assert.equal(titleKey('Cabaret (2024)'), titleKey('cabaret'));
  const shows = [{ id: 'les-miserables-2014', title: 'Les Misérables' }, { id: 'les-miserables-1987', title: 'Les Miserables' }];
  assert.deepEqual(findDuplicateImageGroups([f('les-miserables-2014', 'h'), f('les-miserables-1987', 'h')], shows, { allowlist: [], sharedAllowlist: {} }), []);
});

test('lineage links, priorRuns ids and allowlists make shows related; unrelated third show still flagged', () => {
  const shows = [
    { id: 'a-2026', title: 'A' },
    { id: 'a-tour', title: 'A: The Tour', tourOf: 'a-2026' },
    { id: 'b-2026', title: 'B One Part', priorRuns: [{ id: 'b-2016' }] },
    { id: 'b-2016', title: 'B Both Parts' },
    { id: 'c', title: 'C' },
    { id: 'd', title: 'D' },
    { id: 'z', title: 'Z' },
  ];
  const opts = { allowlist: [{ ids: ['c', 'd'], reason: 'test' }], sharedAllowlist: {} };
  assert.deepEqual(findDuplicateImageGroups([f('a-2026', 'h'), f('a-tour', 'h')], shows, opts), []);
  assert.deepEqual(findDuplicateImageGroups([f('b-2026', 'h'), f('b-2016', 'h')], shows, opts), []);
  assert.deepEqual(findDuplicateImageGroups([f('c', 'h'), f('d', 'h')], shows, opts), []);
  const g = findDuplicateImageGroups([f('c', 'h'), f('d', 'h'), f('z', 'h')], shows, opts);
  assert.deepEqual(g.map((x) => x.ids), [['c', 'd', 'z']]);
});

test('ALLOWED_SHARED_IMAGES pairs count in either direction', () => {
  const shows = [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }];
  assert.deepEqual(findDuplicateImageGroups([f('x', 'h'), f('y', 'h')], shows, { allowlist: [], sharedAllowlist: { y: { owner: 'x' } } }), []);
});

test('hashShowImageFiles hashes only same-size candidates and reports missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-img-'));
  try {
    for (const id of ['p', 'q', 'r']) fs.mkdirSync(path.join(dir, 'images', 'shows', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/shows/p/thumbnail.jpg'), 'same-bytes');
    fs.writeFileSync(path.join(dir, 'images/shows/q/thumbnail.jpg'), 'same-bytes');
    fs.writeFileSync(path.join(dir, 'images/shows/r/thumbnail.jpg'), 'a much longer unique file');
    const shows = ['p', 'q', 'r'].map((id) => ({ id, title: id.toUpperCase(), images: { thumbnail: `/images/shows/${id}/thumbnail.jpg`, poster: `/images/shows/${id}/poster.jpg`, hero: 'https://cdn.example/x.jpg', _tmp: `/images/shows/p/thumbnail.jpg` } }));
    const { files, missing } = hashShowImageFiles(shows, dir);
    assert.deepEqual(files.map((x) => x.showId).sort(), ['p', 'q']);
    assert.equal(missing.length, 3);
    const { groups } = auditDuplicateImages(shows, dir, { allowlist: [], sharedAllowlist: {} });
    assert.deepEqual(groups.map((g) => g.ids), [['p', 'q']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every allowlist entry names 2+ ids and a reason', () => {
  for (const e of DUPLICATE_IMAGE_ALLOWLIST) {
    assert.ok(Array.isArray(e.ids) && e.ids.length >= 2, JSON.stringify(e));
    assert.ok(typeof e.reason === 'string' && e.reason.length > 20, JSON.stringify(e));
  }
});


// ---- lookalike (perceptual) groups, BRO-6995 ----
function art(seed, w = 64, h = 96) {
  let st = seed >>> 0;
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296; };
  const blobs = Array.from({ length: 8 }, () => ({ x: rnd() * w, y: rnd() * h, r: 8 + rnd() * 18, v: 70 + rnd() * 185 }));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 20;
    for (const b of blobs) { const d = Math.hypot(x - b.x, y - b.y); if (d < b.r) v = Math.max(v, b.v * (1 - d / b.r / 1.6)); }
    data[y * w + x] = Math.round(v);
  }
  return imagePhash.signatureFromGray({ data, width: w, height: h });
}
const e = (showId, sig, key = 'poster') => ({ showId, key, path: `/images/shows/${showId}/${key}.jpg`, sig });

test('lookalike: the same picture under two unrelated shows is flagged once per show pair', () => {
  const shows = [{ id: 'rope-2026', title: 'Rope' }, { id: 'lost-boys-2026', title: 'The Lost Boys' }];
  const sig = art(3);
  const groups = findLookalikeImageGroups(
    [e('rope-2026', sig), e('rope-2026', sig, 'thumbnail'), e('lost-boys-2026', sig)], shows, { allowlist: [], sharedAllowlist: {} });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['lost-boys-2026', 'rope-2026']);
  assert.ok(groups[0].similarity >= LOOKALIKE_MIN_SIMILARITY);
});

test('lookalike: different pictures, related shows, and unusable signatures are not flagged', () => {
  const shows = [
    { id: 'a-2026', title: 'A' }, { id: 'b-2026', title: 'B' },
    { id: 'c-2026', title: 'C' }, { id: 'c-tour', title: 'C: The Tour', tourOf: 'c-2026' },
  ];
  const opts = { allowlist: [], sharedAllowlist: {} };
  assert.deepEqual(findLookalikeImageGroups([e('a-2026', art(3)), e('b-2026', art(77))], shows, opts), []);
  assert.deepEqual(findLookalikeImageGroups([e('c-2026', art(3)), e('c-tour', art(3))], shows, opts), []);
  assert.deepEqual(findLookalikeImageGroups([e('a-2026', null), e('b-2026', null)], shows, opts), []);
  assert.deepEqual(findLookalikeImageGroups([e('a-2026', art(3)), e('a-2026', art(3), 'thumbnail')], shows, opts), []);
  assert.deepEqual(findLookalikeImageGroups(null, shows, opts), []);
});

test('lookalike: minSimilarity is respected', () => {
  const shows = [{ id: 'a-2026', title: 'A' }, { id: 'b-2026', title: 'B' }];
  const opts = { allowlist: [], sharedAllowlist: {}, minSimilarity: 1.01 };
  assert.deepEqual(findLookalikeImageGroups([e('a-2026', art(3)), e('b-2026', art(3))], shows, opts), []);
});

test('signatureShowImageFiles signatures real files once, skips non-/images/ paths, reports missing', async () => {
  const sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookalike-'));
  try {
    fs.mkdirSync(path.join(dir, 'images/shows/x'), { recursive: true });
    const raw = Buffer.alloc(64 * 64);
    for (let i = 0; i < raw.length; i++) raw[i] = (i % 64) * 3 + Math.floor(i / 64) % 7;
    await sharp(raw, { raw: { width: 64, height: 64, channels: 1 } }).jpeg().toFile(path.join(dir, 'images/shows/x/poster.jpg'));
    const shows = [{ id: 'x', images: { poster: '/images/shows/x/poster.jpg', thumbnail: '/images/shows/x/gone.jpg', hero: 'https://example.com/h.jpg' } }];
    const { entries, missing } = await signatureShowImageFiles(shows, dir);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].sig && entries[0].sig.sq);
    assert.deepEqual(missing.map((m) => m.key), ['thumbnail']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
