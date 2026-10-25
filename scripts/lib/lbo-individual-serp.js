'use strict';

/**
 * Pick the London Box Office individual (byline) review URLs for `show` out of
 * a SERP result list (BRO-5631, was PR #391). Pure, so the guard is unit-tested
 * apart from the scraper's network calls.
 *
 * Returns every qualifying URL (best first, up to `limit`), not just the first:
 * the year only breaks ties between same-title productions, so an earlier run's
 * review (1536 at the Almeida) can match too. The scraper's page-date guard
 * (withholdStarsUnlessCurrentProduction) drops those and keeps the right one.
 *
 * A URL is accepted only when it is an LBO /news/post/ individual-review shape
 * (never a roundup) and its slug matches `show` as the WINNER across the whole
 * `pool`, at high confidence. Matching against `show` alone would accept a slug
 * that is really about a different show that out-scores it in the pool.
 *
 * @param {Array<string|null|undefined>} urls SERP result URLs, best first
 * @param {{id: string}} show the targeted show
 * @param {object[]} pool every West End show the sitemap path matches against
 * @param {{year?: number|null, limit?: number}} [opts] year passed to the matcher so
 *   same-title productions resolve by date (the targeted show's opening year);
 *   limit caps the URLs returned (default 3, each costs a page fetch)
 * @returns {string[]}
 */
function pickLboIndividualReviewUrls(urls, show, pool, opts = {}) {
  const { matchSlugToShow } = require('./show-matching');
  const limit = opts.limit || 3;
  const out = [];
  for (const raw of urls || []) {
    if (out.length >= limit) break;
    if (!raw) continue;
    const u = String(raw).split(/[?#]/)[0];
    if (!/^https?:\/\/(www\.)?londonboxoffice\.co\.uk\/news\/post\//i.test(u)) continue;
    if (/review-round-?up/i.test(u)) continue;
    if (!/\/news\/post\/review-.+/i.test(u) && !/-review\/?$/i.test(u)) continue;
    const slug = u.replace(/^https?:\/\/[^/]+/, '').replace(/^\/news\/post\//i, '').replace(/\/$/, '');
    const m = matchSlugToShow(slug, pool, opts.year ? { year: opts.year } : {});
    if (m && m.show && m.show.id === show.id && m.confidence === 'high' && !out.includes(u)) out.push(u);
  }
  return out;
}

module.exports = { pickLboIndividualReviewUrls };
