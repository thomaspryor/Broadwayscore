// Google Images hit -> bytes (BRO-3377 Scrapingdog shape). Requires the REAL function (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractGoogleImageBuffer, hasUsableGoogleImage } = require('./google-image-buffer.js');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 1)]);
const isImageBuffer = (b) => b[0] === 0xff && b[1] === 0xd8;
const dataUri = (b) => `data:image/jpeg;base64,${b.toString('base64')}`;

test('Scrapingdog hit downloads the original, not the inline thumbnail', async () => {
  const seen = [];
  const thumb = Buffer.concat([JPEG, Buffer.from('thumb')]);
  const buf = await extractGoogleImageBuffer(
    { _directUrl: true, imageUrl: 'https://x.test/full.jpg', image: dataUri(thumb) },
    { download: async (u) => { seen.push(u); return JPEG; }, isImageBuffer },
  );
  assert.deepEqual(seen, ['https://x.test/full.jpg']);
  assert.equal(buf, JPEG);
});

test('Scrapingdog hit whose original fails falls back to its inline thumbnail', async () => {
  const buf = await extractGoogleImageBuffer(
    { _directUrl: true, imageUrl: 'https://x.test/404.jpg', image: dataUri(JPEG) },
    { download: async () => { throw new Error('404'); }, isImageBuffer },
  );
  assert.ok(buf && buf.equals(JPEG));
});

test('ScrapingBee base64 hit decodes inline with no download', async () => {
  const buf = await extractGoogleImageBuffer({ image: dataUri(JPEG) }, { download: async () => assert.fail('no download'), isImageBuffer });
  assert.ok(buf.equals(JPEG));
});

test('tiny or non-image bytes are rejected', async () => {
  assert.equal(await extractGoogleImageBuffer({ _directUrl: true, imageUrl: 'u' }, { download: async () => Buffer.alloc(10), isImageBuffer }), null);
  assert.equal(await extractGoogleImageBuffer({ _brightdata: true, imageUrl: 'u' }, { download: async () => Buffer.alloc(5000), isImageBuffer }), null);
});

test('hasUsableGoogleImage accepts the three provider shapes only', () => {
  assert.equal(hasUsableGoogleImage({ _directUrl: true, imageUrl: 'u' }), true);
  assert.equal(hasUsableGoogleImage({ _brightdata: true, imageUrl: 'u' }), true);
  assert.equal(hasUsableGoogleImage({ image: 'data:image/png;base64,AA' }), true);
  assert.equal(hasUsableGoogleImage({ imageUrl: 'u' }), false);
  assert.equal(hasUsableGoogleImage({ image: 'https://t.gstatic.com/x' }), false);
});
