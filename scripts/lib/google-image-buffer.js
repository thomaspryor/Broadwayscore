'use strict';
/**
 * Bytes for one Google Images SERP hit (fetch-show-images-auto.js).
 *
 * Direct-URL hits (Bright Data `_brightdata`, Scrapingdog `_directUrl`, BRO-3377)
 * download the full-size original. A ScrapingBee hit carries a base64 data URI
 * thumbnail, decoded inline; a Scrapingdog hit whose original won't download
 * falls back to its inline thumbnail when it has one.
 */
const MIN_BYTES = 3000;

async function extractGoogleImageBuffer(result, { download, isImageBuffer }) {
  if (!result) return null;
  if ((result._brightdata || result._directUrl) && result.imageUrl) {
    try {
      const buffer = await download(result.imageUrl);
      if (buffer && buffer.length >= MIN_BYTES && isImageBuffer(buffer)) return buffer;
    } catch { /* fall through to the inline thumbnail */ }
  }
  if (typeof result.image === 'string' && result.image.startsWith('data:image/')) {
    const commaIdx = result.image.indexOf(',');
    if (commaIdx === -1) return null;
    const buffer = Buffer.from(result.image.substring(commaIdx + 1), 'base64');
    if (buffer.length < MIN_BYTES || !isImageBuffer(buffer)) return null;
    return buffer;
  }
  return null;
}

/** Pure: does this SERP hit carry something extractGoogleImageBuffer can use? */
function hasUsableGoogleImage(r) {
  if (!r) return false;
  if (typeof r.image === 'string' && r.image.startsWith('data:image/')) return true;
  return !!((r._brightdata || r._directUrl) && r.imageUrl);
}

module.exports = { extractGoogleImageBuffer, hasUsableGoogleImage, MIN_BYTES };
