'use strict';

const path = require('path');
const { buildRetryCandidateImages } = require('./google-image-retry-candidate');
const { writeStagedCandidate } = require('./image-candidate-staging');

// Google searches and poster verification happen before this flow. Keep the
// retry builder and verification loop together so tests exercise the same
// poster handoff as fetch-show-images-auto.js, without running its main().
function createGoogleImageRetry({
  extractImageBuffer, compressImage, ensureThumbnailAspect,
  googleResultSource, googleResultMeta, verifyAndCollect, outputBase,
  log = console.log,
}) {
  async function tryNextGoogleCandidate(show, remainingCandidates, previousPoster = null, previousPosterFile = null, previousPosterStaged = null) {
    for (const result of remainingCandidates) {
      try {
        const buffer = await extractImageBuffer(result);
        if (!buffer) continue;

        log(`   ✓ Trying next Google Images candidate (${(buffer.length/1024).toFixed(0)} KB) from ${result.domain}: ${result.title?.substring(0, 50)}`);

        const showDir = path.join(outputBase, show.id);
        const compressed = await compressImage(await ensureThumbnailAspect(buffer), 'thumbnail');
        const _staged = {};
        writeStagedCandidate(_staged, 'thumbnail', { local: `/images/shows/${show.id}/thumbnail.jpg`, final: path.join(showDir, 'thumbnail.jpg') }, compressed);

        const nextRemaining = remainingCandidates.slice(remainingCandidates.indexOf(result) + 1);
        const images = buildRetryCandidateImages({ showId: show.id, previousPoster });
        const _fileSources = { thumbnail: { path: images.thumbnail, source: googleResultSource(result) } };
        if (previousPoster && previousPosterFile && previousPosterFile.path === previousPoster) _fileSources.poster = previousPosterFile;
        if (previousPoster && previousPosterStaged && previousPosterStaged.local === previousPoster) _staged.poster = previousPosterStaged;
        return {
          ...images,
          _verifyBuffer: buffer,
          _verifyMeta: googleResultMeta(result),
          _remainingCandidates: nextRemaining,
          _fileSources,
          _staged,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  return async function collectGoogleImageCandidate(show, googleImages, verifyCtx) {
    while (googleImages && googleImages.thumbnail) {
      // Verification consumes internal fields, so preserve the remaining hits
      // and the independently verified poster before checking the thumbnail.
      const remaining = googleImages._remainingCandidates || [];
      const previousPoster = googleImages.poster || null;
      const previousPosterFile = (googleImages._fileSources && googleImages._fileSources.poster) || null;
      const previousPosterStaged = (googleImages._staged && googleImages._staged.poster) || null;
      const candidate = await verifyAndCollect(googleImages, show, 'Google Images', verifyCtx);
      if (candidate) return candidate;
      if (remaining.length === 0) break;
      googleImages = await tryNextGoogleCandidate(show, remaining, previousPoster, previousPosterFile, previousPosterStaged);
    }
    return null;
  };
}

module.exports = { createGoogleImageRetry };
