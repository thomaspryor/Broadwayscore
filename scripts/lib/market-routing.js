/**
 * Market Routing Classifier
 *
 * Single decision function for "which show directory should this review land in?"
 *
 * Extracted from scripts/lib/review-file-writer.js Guard A + Guard H so that
 * gather-reviews.js (SERP discovery path) and the historical migration script
 * (scripts/audit-we-market-misroutes.js) use the same rules. Thresholds are
 * preserved verbatim — this is a refactor + wiring expansion, not a policy change.
 *
 * Rules (in order):
 *   1. allowCrossMarket opt-in → accept (E2E tests, manual ingestion, transfers)
 *   2. Sibling date reroute (Tier 1, full date): sibling opened ≤30 days from
 *      publishDate AND current show's opening is >90 days from publishDate →
 *      reroute to sibling.
 *   3. Sibling year reroute (Tier 2, fallback for shows without opening dates):
 *      pickRerouteTarget by ID year.
 *   4. WE shows only: URL has explicit Broadway marker or outlet is US-only →
 *      reject (no plausible target).
 *   5. Accept.
 *
 * Pure: no filesystem I/O. Callers pass in shows list (or sibling index).
 */

const { parseDate } = require('./date-utils');
const { pickRerouteTarget } = require('./review-guards');
const { isBroadwayUrl, isLondonMarket } = require('./venue-classification');

const DAY = 86400000;
const SIBLING_CLOSE_DAYS = 30;   // sibling opening this close to review → candidate
const CURRENT_FAR_DAYS = 90;     // current show's opening this far from review → eligible

/**
 * Normalize a title for sibling grouping (same rules as review-file-writer.js).
 */
function normalizeTitle(title) {
  return String(title || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
}

/**
 * Build a sibling index from a shows array. For each show, record its
 * openingDate / ID year plus the list of other shows that share its title.
 *
 * @param {Array<object>} shows
 * @returns {Map<string, { showYear: number|null, openingDate: Date|null, siblings: Array }>}
 */
function buildSiblingIndex(shows) {
  const map = new Map();
  if (!Array.isArray(shows) || shows.length === 0) return map;
  const byTitle = new Map();
  for (const s of shows) {
    const t = normalizeTitle(s.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(s);
  }
  for (const s of shows) {
    const t = normalizeTitle(s.title);
    const group = byTitle.get(t) || [];
    const sibs = group.filter(x => x.id !== s.id);
    if (sibs.length === 0) continue;
    const yearMatch = String(s.id || '').match(/-(\d{4})$/);
    const showYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const opening = s.openingDate ? new Date(s.openingDate) : null;
    map.set(s.id, {
      showYear,
      openingDate: opening && !isNaN(opening.getTime()) ? opening : null,
      siblings: sibs.map(x => {
        const ym = String(x.id || '').match(/-(\d{4})$/);
        const sibOpening = x.openingDate ? new Date(x.openingDate) : null;
        return {
          id: x.id,
          year: ym ? parseInt(ym[1], 10) : null,
          openingDate: sibOpening && !isNaN(sibOpening.getTime()) ? sibOpening : null,
          category: x.category || null,
        };
      }).filter(x => x.year || x.openingDate),
    });
  }
  return map;
}

/**
 * Classify the market routing for a prospective write.
 *
 * @param {object} args
 * @param {string} args.showId — destination show directory candidate
 * @param {string} [args.url]
 * @param {string} [args.outletId]
 * @param {string|Date} [args.publishDate]
 * @param {string} [args.category] — current show's category (west-end/off-west-end/etc.)
 * @param {boolean} [args.allowCrossMarket=false]
 * @param {Set<string>} [args.visited] — already-visited show IDs (prevent cycles)
 * @param {Map} args.siblingIndex — pre-built sibling index (buildSiblingIndex)
 * @returns {{ action: 'accept' | 'reject' | 'reroute', targetShowId?: string, reason?: string }}
 */
function classifyMarketRouting(args) {
  const {
    showId,
    url,
    outletId,
    publishDate,
    category,
    allowCrossMarket = false,
    visited,
    siblingIndex,
  } = args;

  if (allowCrossMarket) {
    return { action: 'accept', reason: 'allowCrossMarket opt-in' };
  }

  const visitedSet = visited || new Set();
  visitedSet.add(showId);

  // --- Sibling date/year reroute (Guard A) ---
  const sibData = siblingIndex && siblingIndex.get(showId);
  if (sibData && sibData.siblings.length) {
    const pubStr = typeof publishDate === 'string' ? publishDate : null;
    const reviewDate = parseDate(pubStr);

    // Tier 1: full-date comparison. Authoritative when the current show has an
    // openingDate — many long-runner WE shows have an ID-year suffix (e.g. "-2024")
    // that diverges from the actual first-opening year (1986, 2013), so year-based
    // Tier 2 misfires. If current has an openingDate, skip Tier 2 entirely.
    if (reviewDate && sibData.openingDate) {
      const distToCurrent = Math.abs(reviewDate - sibData.openingDate) / DAY;
      let best = null;
      for (const sib of sibData.siblings) {
        if (!sib.openingDate || visitedSet.has(sib.id)) continue;
        const distToSib = Math.abs(reviewDate - sib.openingDate) / DAY;
        if (distToSib <= SIBLING_CLOSE_DAYS && distToCurrent > CURRENT_FAR_DAYS) {
          if (!best || distToSib < best.dist) {
            best = { id: sib.id, dist: distToSib, currentDist: distToCurrent };
          }
        }
      }
      if (best) {
        return {
          action: 'reroute',
          targetShowId: best.id,
          reason: `sibling opening ${Math.round(best.dist)}d from publishDate vs current ${Math.round(best.currentDist)}d`,
        };
      }
    } else if (reviewDate && sibData.showYear) {
      // Tier 2: year-level fallback ONLY when the current show has no openingDate.
      // Additionally require the routing to be same-market (or the URL to carry an
      // explicit Broadway marker) — otherwise ID-year proximity alone misroutes
      // legitimate UK reviews of earlier UK productions to a Broadway sibling.
      // Example: a-dolls-house-off-west-end-2026 (null openingDate) with 2022 UK
      // reviews of the Jessica Chastain West End run — nearest sibling by year
      // is a-dolls-house-2023 (BW) but the reviews are NOT about that production.
      const reviewYear = reviewDate.getFullYear();
      const reroute = pickRerouteTarget(sibData.showYear, sibData.siblings, reviewYear);
      if (reroute.action === 'reroute' && !visitedSet.has(reroute.targetShowId)) {
        const target = sibData.siblings.find(s => s.id === reroute.targetShowId);
        const targetIsLondon = target && isLondonMarket(target.category);
        const currentIsLondon = isLondonMarket(category);
        const sameMarket = target && (targetIsLondon === currentIsLondon);
        const hasBroadwayUrlMarker = isBroadwayUrl(url, outletId) !== null;
        if (sameMarket || hasBroadwayUrlMarker) {
          return {
            action: 'reroute',
            targetShowId: reroute.targetShowId,
            reason: `year-level sibling match (review year ${reviewYear} vs current show year ${sibData.showYear})`,
          };
        }
      }
    }
  }

  // --- Guard H: Broadway URL/outlet rejection for WE shows (no routable target) ---
  // This runs when the sibling reroute didn't fire either because there is no
  // sibling Broadway show in shows.json or dates don't line up. The review is
  // still clearly a Broadway review landing in a WE dir, so reject — avoids
  // polluting the WE dir with a file that CV will flag anyway.
  if (category && isLondonMarket(category)) {
    const crossMarketReason = isBroadwayUrl(url, outletId);
    if (crossMarketReason) {
      return { action: 'reject', reason: `cross-market: ${crossMarketReason}` };
    }
  }

  return { action: 'accept' };
}

module.exports = {
  classifyMarketRouting,
  buildSiblingIndex,
  normalizeTitle,
  SIBLING_CLOSE_DAYS,
  CURRENT_FAR_DAYS,
};
