/**
 * Filename-collision policy for /api/admin/ingest-review (BRO-2365).
 *
 * The base filename is `outlet--critic.json`, so a second review by the same
 * critic+outlet for the same show used to silently overwrite the first. Policy:
 * when the file on disk holds a DIFFERENT url, write the incoming review to a
 * versioned filename (`outlet--critic-<sha1(url)[:6]>.json`) instead.
 */
const crypto = require('crypto');

function normalizeReviewUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    for (const k of Array.from(u.searchParams.keys())) {
      if (/^utm_|^fbclid$|^triedRedirect$|^ref$|^mc_eid$/.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).toLowerCase().replace(/\/$/, '');
  }
}

function versionedReviewFilename(filename, url) {
  const hash = crypto.createHash('sha1').update(normalizeReviewUrl(url)).digest('hex').slice(0, 6);
  return filename.replace(/\.json$/, '') + `-${hash}.json`;
}

/**
 * @returns {{ versioned: boolean, filename: string, existingUrl: string|null }}
 * versioned=true means the existing file holds a different review and must not be touched.
 */
function resolveIngestFilename({ filename, existingData, url }) {
  const existingUrl = existingData && typeof existingData.url === 'string' ? existingData.url : null;
  if (existingUrl && normalizeReviewUrl(existingUrl) !== normalizeReviewUrl(url)) {
    return { versioned: true, filename: versionedReviewFilename(filename, url), existingUrl };
  }
  return { versioned: false, filename, existingUrl };
}

module.exports = { normalizeReviewUrl, versionedReviewFilename, resolveIngestFilename };
