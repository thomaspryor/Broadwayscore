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
} = require('./duplicate-images.js');

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

