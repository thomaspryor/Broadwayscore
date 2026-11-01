'use strict';
// When the live fetch of a review page fails (BRO-6762 hole 4), read the newest
// existing Wayback copy before giving up. Only an EXISTING 200 capture is used
// (the CDX index is read; no capture is ever requested), so it never triggers a
// crawl. The copy is read through the same injected fetchPage as the live attempt,
// so a failed live fetch costs one more fetchPage call through the scraper chain
// (web.archive.org is not a free-fetch host there) plus the CDX lookup. Bounded: it only runs after a live failure.

const { archiveSnapshotFetchUrl } = require('./archive-snapshot-url');

const MIN_HTML = 500;
const usable = (h) => typeof h === 'string' && h.length >= MIN_HTML;

/** Newest 200-status capture timestamp (14 digits) for a url, or null. */
async function latestCaptureTimestamp(url, { fetchJson } = {}) {
  const get = fetchJson || (async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(u, { signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } finally { clearTimeout(t); }
  });
  const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp&filter=statuscode:200&limit=-1`;
  try {
    const rows = await get(cdx);
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const last = rows[rows.length - 1];
    const ts = Array.isArray(last) ? last[0] : last;
    return /^\d{14}$/.test(String(ts)) ? String(ts) : null;
  } catch { return null; }
}

/**
 * @param {string} url
 * @param {object} o
 * @param {(u:string)=>Promise<any>} o.fetchPageFn  - same shape the live fetch uses
 * @param {Function} [o.fetchJson]                  - CDX lookup (injectable)
 * @returns {Promise<{html:string|null, via:'live'|'archive'|null, snapshot?:string, error?:string}>}
 */
async function fetchWithArchiveFallback(url, { fetchPageFn, fetchJson } = {}) {
  let liveError = null;
  try {
    const r = await fetchPageFn(url);
    const html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
    if (usable(html)) return { html, via: 'live' };
    liveError = `no usable HTML (${html ? html.length : 0} chars)`;
  } catch (e) { liveError = `fetch failed: ${e.message}`; }
  const ts = await latestCaptureTimestamp(url, { fetchJson });
  const snapUrl = ts ? archiveSnapshotFetchUrl(url, ts) : null;
  if (!snapUrl) return { html: null, via: null, error: `${liveError}; no archive.org capture` };
  try {
    const r = await fetchPageFn(snapUrl);
    const html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
    if (usable(html)) return { html, via: 'archive', snapshot: ts };
    return { html: null, via: null, error: `${liveError}; archive copy unusable` };
  } catch (e) {
    return { html: null, via: null, error: `${liveError}; archive fetch failed: ${e.message}` };
  }
}

/**
 * What to do with extracted text when the page came from archive.org.
 * 'ok' = proceed; 'stub' = live fetch failed and the copy is thin, queue a retry stub;
 * 'refuse' = thin copy and no stub requested (BRO-5874 refusal).
 */
function archiveCopyDisposition({ viaArchive, explicitSnapshot, stubOnFailure, textLength }) {
  if (!viaArchive && !explicitSnapshot) return 'ok';
  if ((textLength || 0) >= 1000) return 'ok';
  if (viaArchive && !explicitSnapshot && stubOnFailure) return 'stub';
  return 'refuse';
}

module.exports = {
  archiveCopyDisposition, fetchWithArchiveFallback, latestCaptureTimestamp };
