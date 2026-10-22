const fs = require('fs');
const path = require('path');
const { matchRemotePattern } = require('next/dist/shared/lib/match-remote-pattern');
const IMAGE_POINTER_BASELINE = require('./image-pointer-baseline.json');

/**
 * BRO-3204: existing missing files warn so unrelated data pushes can proceed.
 * Remove entries from image-pointer-baseline.json as their files/pointers are
 * repaired. Match the exact pointer and failure, so a baselined show cannot
 * acquire another broken image without failing validation.
 */
function imagePointerSeverity(problem) {
  return IMAGE_POINTER_BASELINE.some(entry =>
    entry.id === problem.id && entry.key === problem.key &&
    entry.value === problem.value && entry.reason === problem.reason
  ) ? 'warn' : 'error';
}

/** Validate stored hero/poster pointers without fetching or changing any data. */
function findImagePointerProblems(shows, { publicDir, remotePatterns = [] }) {
  const imagesDir = path.resolve(publicDir, 'images');
  const problems = [];
  for (const show of shows) {
    for (const key of ['hero', 'poster']) {
      const value = show.images?.[key];
      if (value == null) continue;
      let reason;
      try {
        if (typeof value !== 'string' || !value.trim()) {
          reason = 'expected a non-empty image path or URL';
        } else if (value.startsWith('/') && !value.startsWith('//')) {
          const pathname = decodeURIComponent(value.split(/[?#]/)[0]);
          const file = path.resolve(publicDir, `.${pathname}`);
          const relative = path.relative(imagesDir, file);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            reason = 'local image must be under public/images/';
          } else if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            reason = 'local image file does not exist';
          }
        } else {
          const url = new URL(value);
          if (!['https:', 'http:'].includes(url.protocol) || !remotePatterns.some(p => matchRemotePattern(p, url))) {
            reason = 'remote image is not allowed by next.config.js images.remotePatterns';
          }
        }
      } catch {
        reason = 'invalid or unreadable image pointer';
      }
      if (reason) problems.push({ id: show.id, key, value, reason });
    }
  }
  return problems;
}

module.exports = { findImagePointerProblems, imagePointerSeverity };
