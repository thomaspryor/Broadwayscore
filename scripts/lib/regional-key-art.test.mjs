// BRO-7265: regional key-art card formats and the hand-verified applier's pure parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { cardFit, regionalLocalPaths, writeRegionalFormats, entryProblem, imagesAction } = require('./regional-key-art.js');

test('cardFit only cover-crops art already close to the card shape', () => {
  const poster = 480 / 720;
  assert.equal(cardFit(2 / 3, poster), 'cover');
  assert.equal(cardFit(0.7, poster), 'cover'); // ~5% of the width goes
  // A 4:5 poster lost 17% of its width ("No Exit" -> "o Exit") under the old <= 0.85 rule.
  assert.equal(cardFit(0.8, poster), 'contain');
  assert.equal(cardFit(1.9, poster), 'contain'); // landscape title art is letterboxed whole
  assert.equal(cardFit(0.5625, poster), 'cover'); // 9:16 keeps 84% of its height
  const hero = 1600 / 1000;
  assert.equal(cardFit(1.5, hero), 'cover');
  assert.equal(cardFit(0.8, hero), 'contain'); // a portrait poster is not cut to a strip of its middle
  assert.equal(cardFit(3.1, hero), 'contain');
  for (const bad of [NaN, 0, -1, Infinity]) assert.equal(cardFit(bad, poster), 'contain');
});

test('writeRegionalFormats writes the three card sizes at the regional paths', async () => {
  const sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-7265-'));
  try {
    // 4:5 source with bright stripes near both side edges (not touching them, so trim keeps them).
    // A cover crop to 2:3 drops ~133px of width, so it cannot keep both stripes wherever it centres.
    const stripe = await sharp({ create: { width: 40, height: 1000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const src = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#203040' } })
      .composite([{ input: stripe, left: 20, top: 0 }, { input: stripe, left: 740, top: 0 }])
      .png().toBuffer();
    await writeRegionalFormats(sharp, src, dir);
    const dims = {};
    for (const f of ['poster', 'thumbnail', 'hero']) {
      const m = await sharp(path.join(dir, `${f}.webp`)).metadata();
      dims[f] = `${m.width}x${m.height}`;
    }
    assert.deepEqual(dims, { poster: '480x720', thumbnail: '300x450', hero: '1600x1000' });
    // contained, so both stripes survive inside the poster (bright pixels on each side of centre)
    const { data, info } = await sharp(path.join(dir, 'poster.webp')).raw().toBuffer({ resolveWithObject: true });
    const row = Math.floor(info.height / 2) * info.width * info.channels;
    const bright = [0, 0];
    for (let x = 0; x < info.width; x++) if (data[row + x * info.channels] > 200) bright[x < info.width / 2 ? 0 : 1]++;
    assert.ok(bright[0] > 0 && bright[1] > 0, `a side stripe was cropped away (${bright})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applier refuses entries it cannot attribute and builds a compare-and-set images edit', () => {
  const show = { id: 'x-regional-2026', category: 'regional', images: { thumbnail: '/images/shows/x-regional-2026/thumbnail.jpg', poster: null, hero: null } };
  const ok = { showId: show.id, page: 'https://theatre.example/x', image: 'https://theatre.example/x.jpg' };
  assert.equal(entryProblem(ok, show), null);
  assert.match(entryProblem(ok, undefined), /not in shows.json/);
  assert.match(entryProblem(ok, { ...show, category: 'broadway' }), /not regional/);
  assert.match(entryProblem({ ...ok, image: 'http://theatre.example/x.jpg' }, show), /https/);
  assert.match(entryProblem({ ...ok, page: '' }, show), /https/);
  assert.match(entryProblem(ok, { ...show, rejectedImageUrls: [ok.image] }), /rejectedImageUrls/);

  const a = imagesAction(show, 'theatre page');
  assert.deepEqual(a.oldValue, show.images);
  assert.deepEqual(a.newValue, regionalLocalPaths(show.id));
  assert.equal(a.field, 'images');
  assert.equal(imagesAction({ ...show, images: regionalLocalPaths(show.id) }), null); // same paths: files only, no data edit
  assert.equal(imagesAction({ ...show, images: undefined }).oldValue, null);
});
