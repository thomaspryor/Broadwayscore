import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { checkFile } = require('./check-image-aspect');
const { getImageDimensions } = require('./lib/image-dimensions');
const { downloadImage } = require('./enrich-west-end-shows');
const { hasChanges, buildDigestItems } = require('./send-daily-digest');
const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts/check-image-aspect.js');

function run(args, env = {}, preload = []) {
  return spawnSync(process.execPath, [...preload, script, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

async function image(file, width, height) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: 'red' } }).toFile(file);
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4734-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the CLI rejects active landscape posters, including alternate extensions, but skips closed shows and thumbnails', async t => {
  const dir = scratch(t);
  const catalog = path.join(dir, 'shows.json');
  fs.writeFileSync(catalog, JSON.stringify({ shows: [
    { id: 'active', status: 'open' }, { id: 'future', status: 'announced' },
    { id: 'closed', status: 'closed' },
  ] }));
  await image(path.join(dir, 'active/poster.jpg'), 200, 300);
  await image(path.join(dir, 'active/poster.webp'), 300, 168);
  await image(path.join(dir, 'future/poster.png'), 270, 186);
  await image(path.join(dir, 'closed/poster.jpg'), 318, 159);
  await image(path.join(dir, 'active/thumbnail.jpg'), 300, 168);
  const env = { IMAGE_ASPECT_SHOWS_PATH: catalog, IMAGE_ASPECT_IMAGES_DIR: dir };
  const result = run(['--audit', '--active-posters'], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Checked 3 non-closed poster files/);
  assert.match(result.stderr, /Found 2 image violation/);
  assert.doesNotMatch(result.stderr, /closed\/poster|thumbnail\.jpg/);
  fs.unlinkSync(path.join(dir, 'active/poster.webp'));
  fs.unlinkSync(path.join(dir, 'future/poster.png'));
  const clean = run(['--audit', '--active-posters'], env);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});

test('the gate works without sharp in the daily digest checkout', async t => {
  const dir = scratch(t);
  const preload = path.join(dir, 'no-sharp.cjs');
  fs.writeFileSync(preload, `const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'sharp') throw new Error('sharp not installed');
  return load.call(this, name, ...args);
};`);
  for (const ext of ['jpg', 'png', 'webp']) {
    const file = path.join(dir, `poster.${ext}`);
    await image(file, 300, 168);
    const dims = getImageDimensions(fs.readFileSync(file));
    assert.deepEqual(dims, { width: 300, height: 168 });
    const result = run(['--files', file], {}, ['--require', preload]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /300x168/);
    await image(file, 200, 300);
    assert.equal(run(['--files', file], {}, ['--require', preload]).status, 0);
  }
  const invalid = path.join(dir, 'poster.jpg');
  fs.writeFileSync(invalid, 'not an image');
  assert.equal(run(['--files', invalid], {}, ['--require', preload]).status, 1);
});

test('the enrichment writer checks every role before replacing existing art', async t => {
  const dir = scratch(t);
  for (const [role, width, height] of [['poster', 300, 168], ['thumbnail', 318, 159], ['hero', 200, 300]]) {
    const file = path.join(dir, `${role}.jpg`);
    await image(file, role === 'hero' ? 300 : 200, role === 'hero' ? 168 : 200);
    const original = fs.readFileSync(file);
    const source = path.join(dir, 'source.jpg');
    await image(source, width, height);
    const download = async (_url, dest) => fs.copyFileSync(source, dest);
    await assert.rejects(downloadImage('unused', file, download), /expected/);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.ok(!fs.existsSync(path.join(dir, `${role}.candidate.jpg`)));
    await image(source, role === 'hero' ? 300 : 200, role === 'hero' ? 168 : 300);
    await downloadImage('unused', file, download);
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(source));
    assert.equal((await checkFile(file)).ok, true);
  }
});

test('poster violations surface first in the digest even with no score activity', () => {
  const changes = { newShows: [], scoreChanges: [], audienceChanges: [], posterAspect: {
    violations: [{ showId: 'paparazzi', reason: '270x186' }],
  } };
  assert.equal(hasChanges(changes), true);
  assert.match(buildDigestItems(changes)[0].title, /Poster aspect: 1/);
  changes.newShows = Array.from({ length: 12 }, (_, i) => ({ title: `Show ${i}`, market: 'broadway' }));
  assert.match(buildDigestItems(changes)[0].detail, /paparazzi: 270x186/);
  changes.posterAspect = { violations: [], error: 'Unreadable image directory' };
  assert.equal(buildDigestItems(changes)[0].title, 'Poster aspect audit failed');
});

test('non-closed shows in the real catalog have zero poster violations (direct CLI audit)', t => {
  const dir = scratch(t);
  const corePath = path.join(root, 'data/shows.json');
  const catalog = fs.existsSync(corePath) ? JSON.parse(fs.readFileSync(corePath)) : {
    shows: require('../public/data/mobile-shows.json').shows.map(s => ({ id: s.id, status: s.st })),
  };
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  const result = run(['--audit', '--active-posters'], { IMAGE_ASPECT_SHOWS_PATH: file });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Checked [1-9]\d* non-closed poster files/);
});
