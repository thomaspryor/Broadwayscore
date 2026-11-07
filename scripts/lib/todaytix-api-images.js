'use strict';

const { isRejectedImage } = require('./image-source-match');
const { resolveMarketSlug } = require('./verify-image');

// Keep the filename and known-asset filter ahead of paid vision checks.
const COMING_SOON_ASSET_IDS = new Set([
  '74xXALpVG4Bdn59x8L9OYN', '42EOxYmUHQE0Xuza0dUlJm', '1Ya0iMOMWjrOvnZPMv9y8k',
  '6W6O3eG33mXg3uJes4DBQ2', 'Y2lDO0gaKjUKp333ZG3zW', '3khjL5U7k9860pnRWY6wxe',
  '3kXlmb7NIDQUq2fEi8FK8C', '2NXMbF8ZGgylEVESpiUIlf', '4dVF8DYwWDn4B5OFSi3x3c',
]);

function isComingSoon(url) {
  const asset = url && url.match(/ctfassets\.net\/[^/]+\/([^/]+)/);
  return url && (/coming.?soon/i.test(url) || /NORAM[_\s]/i.test(url)
    || /square_photo\.png/i.test(url) || COMING_SOON_ASSET_IDS.has(asset && asset[1]));
}

const addWebp = (url) => !url ? null : url.includes('?') ? url : `${url}?fm=webp&q=90`;

/**
 * Verify every distinct API slot sequentially through the shared rate limiter.
 * A confident mismatch or unavailable download only removes slots using that
 * URL. Verifier exceptions retain the existing fail-open policy, without
 * skipping the other slots.
 * Dependencies are injectable for offline replay of recorded source URLs.
 */
async function fetchTodayTixApiImages(show, apiData, {
  verifyCtx = null, downloadImage, verifyImage, log = () => {},
} = {}) {
  const images = {
    thumbnail: apiData.square || apiData.imageForAds || null,
    poster: apiData.poster || null,
    hero: apiData.hero || apiData.headerImage || null,
  };
  for (const [slot, url] of Object.entries(images)) {
    images[slot] = isComingSoon(url) || isRejectedImage({ [slot]: url }, show) ? null : addWebp(url);
  }
  if (!images.thumbnail && !images.poster) return null;
  if (!verifyCtx) return images;

  const verify = verifyImage || require('./verify-image').verifyImage;
  const dropped = new Set();
  for (const url of new Set(Object.values(images).filter(Boolean))) {
    try {
      const buffer = await downloadImage(url);
      if (!buffer) {
        dropped.add(url);
        log('   ⚠ TodayTix API image unavailable, dropping this URL');
        continue;
      }
      const result = await verify(buffer, show.title, {
        year: show.openingDate ? show.openingDate.substring(0, 4) : null,
        openingDate: show.openingDate,
        market: resolveMarketSlug(show.category, show.market),
        // venue-write-guard-ok: pass the existing venue to vision, no show data is written.
        venue: show.venue,
        rateLimiter: verifyCtx.rateLimiter,
      });
      if (result.match === false && result.confidence === 'high') {
        dropped.add(url);
        log(`   ✗ TodayTix API image REJECTED: ${result.description} [${result.issues?.join(', ')}]`);
      } else {
        log(`   ✓ TodayTix API image checked: ${result.description}`);
      }
    } catch (err) {
      log(`   ⚠ TodayTix API verification failed (${err.message}), accepting based on URL check`);
    }
  }
  for (const slot of Object.keys(images)) if (dropped.has(images[slot])) images[slot] = null;
  return images.thumbnail || images.poster ? images : null;
}

module.exports = { fetchTodayTixApiImages };
