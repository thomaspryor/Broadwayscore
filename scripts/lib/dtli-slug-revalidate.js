/**
 * Re-check EXISTING DTLI slug-map entries against the year rule (BRO-8266).
 *
 * discover-dtli-slugs.js applied the year rule only to NEW candidates; a
 * mapping written before the rule (or while the page was empty) was never
 * looked at again unless someone ran --force. galileo-2026 sat on the 2012
 * Classic Stage Company page ("galileo", five 2012 reviews) and the poller
 * would have ingested those reviews for the 2026 Broadway revival.
 *
 * Pure decision code: the page fetch is injected so tests need no network.
 */
const { dtliSlugPredatesShow, extractDtliReviewYears, dtliShowYear } = require('./review-guards');

/** Closed shows cannot gain a wrong page that matters; skip them in the weekly run. */
function isLiveWindowShow(show) {
  return !!show && show.status !== 'closed';
}

/**
 * @param {Record<string,string>} mapping - showId -> dtli slug (slugMap.shows)
 * @param {Map<string,object>|Record<string,object>} showsById
 * @param {(slug:string)=>Promise<{ok:boolean, body?:string}|null>} fetchPage
 * @param {object} [opts]
 * @param {(show:object)=>boolean} [opts.include] - which shows to check (default: all with a known year)
 * @param {()=>boolean} [opts.exceeded] - stop early (run budget)
 * @returns {Promise<{checked:number, wrong:Array<{showId,slug,showYear,years}>, unprobed:string[]}>}
 */
async function findWrongYearMappings(mapping, showsById, fetchPage, opts = {}) {
  const get = (id) => (showsById instanceof Map ? showsById.get(id) : showsById[id]);
  const include = opts.include || (() => true);
  const out = { checked: 0, wrong: [], unprobed: [] };
  const cache = new Map(); // slug -> years|null (a slug shared by two ids is probed once)
  for (const [showId, rawSlug] of Object.entries(mapping || {})) {
    if (opts.exceeded && opts.exceeded()) break;
    const show = get(showId);
    if (!show || !include(show)) continue;
    const showYear = dtliShowYear(show);
    if (!showYear) continue;
    const slug = String(rawSlug).replace(/^shows\//, '');
    if (!cache.has(slug)) {
      const res = await fetchPage(slug);
      cache.set(slug, res && res.ok && typeof res.body === 'string' ? extractDtliReviewYears(res.body) : null);
    }
    const years = cache.get(slug);
    out.checked++;
    if (years === null) { out.unprobed.push(showId); continue; } // no evidence is not a wrong year
    if (dtliSlugPredatesShow(years, showYear)) out.wrong.push({ showId, slug, showYear, years });
  }
  return out;
}

module.exports = { findWrongYearMappings, isLiveWindowShow };
