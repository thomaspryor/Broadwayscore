'use strict';
/**
 * The press-night census (BRO-6669): which reviews exist for a show's opening night, from the aggregator archive and,
 * for NYC markets, the live BWW review roundup. Shared by the press-night probe (scripts/press-night-record.js) and the
 * lane watchdog (scripts/lane-watchdog.js), so both judge "the live site is missing reviews" against the same list.
 * Never reads the lane's own ledger.
 *
 * Kept outside scripts/lib/opening-night-lane/ on purpose: everything in that folder is part of the lane code hash
 * (rehearsal.js laneCodeFiles), and the census pulls in the scraper.
 */

/** Reject a promise that takes longer than `ms`. */
function withTimeout(p, ms, what) {
  if (!ms) return p;
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * @param {{showId:string, market?:string, show:object|null, bwwUrl?:string|null, noFetch?:boolean, timeoutMs?:number}} input
 *   bwwUrl: a roundup URL already known (skips discovery). timeoutMs bounds discovery and the page fetch each.
 * @returns {Promise<{census:object, note:string}>}  census.bwwRoundupUrl is set when the live roundup was merged.
 */
async function buildPressNightCensus({ showId, market = 'broadway', show, bwwUrl = null, noFetch = false, timeoutMs = 0 }) {
  const { buildCensusFromArchives, unionCensus, parseBwwRoundup } = require('./review-census');
  const archive = buildCensusFromArchives(showId, { market, show: show || undefined, dropLegacyArchive: true });
  const nyc = ['broadway', 'off-broadway', 'nyc'].includes(market);
  if (!nyc || noFetch || archive.sourcesPresent.includes('bww-roundup') || !show) return { census: archive, note: 'archive only' };
  let url = bwwUrl || null;
  try {
    if (!url) {
      const { discoverBwwRoundupUrl } = require('./bww-rr-discover');
      const found = await withTimeout(discoverBwwRoundupUrl(show), timeoutMs, 'BWW roundup discovery');
      url = found && found.url;
    }
    if (!url) return { census: archive, note: 'no BWW roundup found' };
    const { fetchPage } = require('./scraper');
    const page = await withTimeout(fetchPage(url), timeoutMs, 'BWW roundup fetch');
    const html = page && page.content;
    if (!html) return { census: archive, note: `BWW roundup fetch empty: ${url}` };
    const { verifyAggregatorUrl } = require('./show-match-verifier');
    const v = verifyAggregatorUrl({ url, html, show, openingDate: show.openingDate });
    if (!v.isValid && v.rejectReason !== 'no-significant-title-tokens') return { census: archive, note: `BWW roundup rejected (${v.rejectReason}): ${url}` };
    const rows = parseBwwRoundup(html, showId);
    if (!rows.length) return { census: archive, note: `BWW roundup parsed 0 reviews: ${url}` };
    const merged = unionCensus([{ source: 'archive', reviews: archive.entries }, { source: 'bww-roundup-live', reviews: rows }], { dropLegacyArchive: true });
    merged.sourcesPresent = [...archive.sourcesPresent, 'bww-roundup-live'];
    merged.bwwRoundupUrl = url;
    return { census: merged, note: `archive + live BWW roundup (${rows.length} rows): ${url}` };
  } catch (e) {
    return { census: archive, note: `BWW roundup fetch failed: ${String(e.message || e).slice(0, 160)}` };
  }
}

module.exports = { buildPressNightCensus, withTimeout };
