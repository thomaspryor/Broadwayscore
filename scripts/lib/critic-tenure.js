/**
 * Critic/outlet tenure check (BRO-5222 gap 4). Advisory.
 *
 * audit-critic-outlets.js already flags a critic at an outlet holding under
 * 10% of their reviews. That misses a row at the critic's REAL outlet in a
 * year they were not writing there (a Variety row for a critic who had moved
 * to the NYT ten years earlier), and a row at an outlet no verified text
 * supports. This builds, from verified rows only, each critic's first and
 * last year at each outlet and flags:
 *   outside_tenure   the pair has >= MIN_PAIR_VERIFIED verified rows, the row's
 *                    year is more than TENURE_SLACK_YEARS outside them, and
 *                    the critic has >= MIN_ELSEWHERE_VERIFIED verified rows at
 *                    one other outlet that year
 *   unsupported_pair the row has no verified text, the pair has no verified
 *                    row at all, and the critic has >= MIN_CRITIC_VERIFIED
 *                    verified rows elsewhere
 * "Verified" = text a fetch stored and the content tier accepted, so a made-up
 * row cannot vouch for itself.
 */
'use strict';

const MIN_PAIR_VERIFIED = 3;
const MIN_CRITIC_VERIFIED = 5;
const TENURE_SLACK_YEARS = 1;
/** Verified rows at another outlet in the row's year needed to say the critic was elsewhere. */
const MIN_ELSEWHERE_VERIFIED = 3;
const UNNAMED_CRITIC = /^(unknown|staff|anonymous|n\/a|none)$/i;

/**
 * @param {object} data - review-text JSON
 * @returns {boolean}
 */
function isVerifiedRow(data) {
  if (!data || !data.url) return false;
  if (!['complete', 'truncated'].includes(data.contentTier)) return false;
  return typeof data.fullText === 'string' && data.fullText.length >= 1000;
}

/**
 * Year the review ran: publishDate when it parses, else the production year
 * from the show id suffix.
 * @param {string} showId
 * @param {object} data
 * @returns {number|null}
 */
function reviewYear(showId, data) {
  const m = String((data && data.publishDate) || '').match(/^(\d{4})/);
  if (m) return Number(m[1]);
  const s = String(showId || '').match(/-(\d{4})$/);
  return s ? Number(s[1]) : null;
}

/**
 * @param {Object<string, {displayName: string, reviews: Array<{showId: string, file: string, outlet: string, year: number|null, verified: boolean}>}>} critics
 * @param {{skipCritics?: string[]}} [opts]
 * @returns {Array<object>} flags
 */
function findTenureFlags(critics, opts = {}) {
  const skip = new Set(opts.skipCritics || []);
  const flags = [];
  for (const [criticSlug, c] of Object.entries(critics)) {
    if (skip.has(criticSlug) || UNNAMED_CRITIC.test(String(c.displayName || criticSlug).trim())) continue;
    const verified = c.reviews.filter(r => r.verified && Number.isFinite(r.year));
    if (verified.length === 0) continue;
    const tenure = {};
    const yearCounts = {}; // outlet -> year -> verified rows
    for (const r of verified) {
      const t = tenure[r.outlet] || (tenure[r.outlet] = { first: r.year, last: r.year, count: 0 });
      t.first = Math.min(t.first, r.year);
      t.last = Math.max(t.last, r.year);
      t.count++;
      const yc = yearCounts[r.outlet] || (yearCounts[r.outlet] = {});
      yc[r.year] = (yc[r.year] || 0) + 1;
    }
    const elsewhereIn = (outlet, year) => Object.entries(yearCounts)
      .filter(([o, yc]) => o !== outlet && (yc[year] || 0) >= MIN_ELSEWHERE_VERIFIED)
      .map(([o, yc]) => `${o} (${yc[year]})`);
    for (const r of c.reviews) {
      const t = tenure[r.outlet];
      const base = { critic: c.displayName, criticSlug, outlet: r.outlet, showId: r.showId, file: r.file, year: r.year };
      if (t && t.count >= MIN_PAIR_VERIFIED && Number.isFinite(r.year)
        && (r.year < t.first - TENURE_SLACK_YEARS || r.year > t.last + TENURE_SLACK_YEARS)) {
        const others = elsewhereIn(r.outlet, r.year);
        if (others.length > 0) {
          flags.push({ ...base, kind: 'outside_tenure', tenure: { first: t.first, last: t.last, count: t.count }, verifiedElsewhereThatYear: others });
        }
        continue;
      }
      if (!t && !r.verified && verified.length >= MIN_CRITIC_VERIFIED) {
        flags.push({ ...base, kind: 'unsupported_pair', verifiedOutlets: Object.fromEntries(Object.entries(tenure).map(([o, x]) => [o, `${x.first}-${x.last} (${x.count})`])) });
      }
    }
  }
  return flags.sort((a, b) => (a.criticSlug + a.showId).localeCompare(b.criticSlug + b.showId));
}

module.exports = { isVerifiedRow, reviewYear, findTenureFlags, MIN_PAIR_VERIFIED, MIN_CRITIC_VERIFIED, TENURE_SLACK_YEARS, MIN_ELSEWHERE_VERIFIED };
