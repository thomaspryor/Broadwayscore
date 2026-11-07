import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGoogleImageRetry } = require('../../scripts/lib/google-image-retry');

// Exercise the production loop AND its retry builder. Only network, image
// processing, and verification are replaced, so dropping the poster in either
// the loop's handoff or the builder makes the regression fail.
function fixture({ poster = true, acceptAt = 2, hits = 1, verifyCtx = {} } = {}) {
  const show = { id: 'gimme-a-sign-off-broadway-2026' };
  const base = `/images/shows/${show.id}`;
  const posterPath = poster ? `${base}/poster.jpg` : null;
  const posterFile = { path: posterPath, source: 'https://art.example/poster.jpg' };
  const posterStaged = { local: posterPath, final: `/unused/${show.id}/poster.jpg`, bytes: Buffer.from('poster') };
  const remaining = Array.from({ length: hits }, (_, i) => ({
    imageUrl: `https://art.example/thumbnail-${i + 2}.jpg`,
    title: `thumbnail ${i + 2}`, domain: 'art.example', buffer: Buffer.from(`thumbnail ${i + 2}`),
  }));
  const images = {
    thumbnail: `${base}/thumbnail.jpg`, poster: posterPath, hero: null,
    _verifyBuffer: Buffer.from('thumbnail 1'), _remainingCandidates: remaining,
    _fileSources: poster ? { poster: posterFile } : {},
    _staged: poster ? { poster: posterStaged } : {},
  };
  const seen = [];
  const downloads = [];
  const collect = createGoogleImageRetry({
    outputBase: '/unused', log() {},
    extractImageBuffer: async hit => { downloads.push(hit); return hit.buffer; },
    ensureThumbnailAspect: async bytes => bytes,
    compressImage: async bytes => bytes,
    googleResultSource: hit => hit.imageUrl,
    googleResultMeta: hit => ({ pageDomain: hit.domain, pageTitle: hit.title }),
    verifyAndCollect: async (candidate, actualShow, tier, context) => {
      assert.equal(actualShow, show);
      assert.equal(tier, 'Google Images');
      assert.equal(context, verifyCtx);
      seen.push({ buffer: candidate._verifyBuffer, poster: candidate.poster });
      // The real verifier consumes these fields, including on rejection.
      delete candidate._remainingCandidates;
      delete candidate._verifyBuffer;
      delete candidate._verifyMeta;
      if (seen.length !== acceptAt) return null;
      return { images: candidate, verifyResult: { imageType: 'promotional_art', confidence: 'high' }, score: 32 };
    },
  });
  return { run: () => collect(show, images, verifyCtx), show, images, seen, downloads, remaining, posterPath, posterFile, posterStaged };
}

test('rejected first thumbnail retains the distinct poster in the accepted second candidate', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(f.seen.length, 2);
  assert.deepEqual(f.downloads, [f.remaining[0]]);
  assert.equal(f.seen[0].buffer.toString(), 'thumbnail 1');
  assert.equal(f.seen[1].buffer.toString(), 'thumbnail 2');
  assert.equal(result.images.thumbnail, f.images.thumbnail);
  assert.equal(result.images.poster, f.posterPath);
  assert.equal(result.images.hero, null);
  assert.equal(result.images._fileSources.poster, f.posterFile);
  assert.equal(result.images._staged.poster, f.posterStaged);
  assert.deepEqual(result.images._staged.thumbnail.bytes, f.remaining[0].buffer);
  assert.equal(result.images._fileSources.thumbnail.source, f.remaining[0].imageUrl);
  assert.equal(result.score, 32);
});

test('poster and its staged bytes survive multiple rejected thumbnails', async () => {
  const f = fixture({ acceptAt: 3, hits: 2 });
  const result = await f.run();
  assert.equal(f.seen.length, 3);
  assert.deepEqual(f.downloads, f.remaining);
  assert.ok(f.seen.every(candidate => candidate.poster === f.posterPath));
  assert.equal(result.images._fileSources.poster, f.posterFile);
  assert.equal(result.images._staged.poster, f.posterStaged);
});

test('retry without a poster never invents one', async () => {
  const f = fixture({ poster: false });
  const result = await f.run();
  assert.equal(f.seen.length, 2);
  assert.equal(result.images.poster, null);
  assert.equal(result.images._fileSources.poster, undefined);
  assert.equal(result.images._staged.poster, undefined);
});

test('first accepted candidate returns unchanged without downloading a retry', async () => {
  const f = fixture({ acceptAt: 1, verifyCtx: null });
  assert.equal((await f.run()).images, f.images);
  assert.equal(f.seen.length, 1);
  assert.equal(f.downloads.length, 0);
});

test('exhausted rejected candidates return null and are each tried once', async () => {
  const f = fixture({ acceptAt: 99, hits: 2 });
  assert.equal(await f.run(), null);
  assert.equal(f.seen.length, 3);
  assert.deepEqual(f.downloads, f.remaining);
});

test('no remaining candidates stops after the first rejection', async () => {
  const f = fixture({ hits: 0 });
  assert.equal(await f.run(), null);
  assert.equal(f.seen.length, 1);
  assert.equal(f.downloads.length, 0);
});

test('unreadable retry hits are skipped before accepting the next candidate', async () => {
  const f = fixture({ hits: 2 });
  f.remaining[0].buffer = null;
  assert.equal((await f.run()).images.poster, f.posterPath);
  assert.deepEqual(f.downloads, f.remaining);
  assert.equal(f.seen[1].buffer.toString(), 'thumbnail 3');
});

test('a missing initial result returns null without verification or downloads', async () => {
  const collect = createGoogleImageRetry({
    verifyAndCollect() { assert.fail('no image to verify'); },
    extractImageBuffer() { assert.fail('no candidates to download'); },
  });
  assert.equal(await collect({}, null, {}), null);
  assert.equal(await collect({}, { thumbnail: null }, {}), null);
});
