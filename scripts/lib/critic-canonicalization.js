/**
 * critic-canonicalization.js — defense-in-depth for critic mis-attribution.
 *
 * Aggregators occasionally credit a review to the wrong person. The most common
 * failure mode is a multi-critic confusion where an aggregator page lists the
 * outlet's frequent byline instead of the actual author of a one-off post.
 *
 * Root incident (Rocky Horror 2026-04-23): BWW RR listed "David Finkle, Cote
 * Notices" for the Cote Notices Rocky Horror review. The actual byline on
 * cotenotices.substack.com/p/rocky-horror-show is David Cote (the publication's
 * owner). David Finkle is a real critic (at NYSR / HuffPost), so the mistake
 * isn't auto-detectable from a "is this a known critic" check — Finkle IS a
 * known critic, just not THIS outlet's critic.
 *
 * The URL-dedup fix in Session 3 #12 catches this when both files point at the
 * same URL (after tracking-param stripping). This map is the second line of
 * defense for cases where the URLs legitimately differ (say, two different
 * crawls landed at different mirror URLs) but the outlet+critic pair is a
 * known mis-attribution.
 *
 * Map shape: { canonicalOutletId: { incorrectCriticName: canonicalCriticName } }
 *  - Keys are normalized via normalizeCriticKey() (lowercased, stripped of
 *    non-alnum) so "David Finkle" / "david-finkle" / "David  Finkle" all hit.
 *  - Values preserve the display-case canonical name.
 *
 * Keep this list SHORT and CITED. Every entry should have a comment pointing
 * at the source evidence (URL + date). Do not use this map to paper over a
 * legitimate multi-critic outlet arrangement — if the outlet genuinely uses
 * multiple bylines, the fix is at the outlet-registry.json level.
 */

function normalizeCriticKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

// Cite the incident, the evidence URL, and the canonical truth for every entry.
const CRITIC_CANONICAL_MAP = {
  // Cote Notices is a single-author Substack (David Cote). BWW Review Roundups
  // have twice credited David Finkle. Rocky Horror 2026-04-23:
  // broadwayworld.com/article/Review-Roundup-THE-ROCKY-HORROR-SHOW-Returns-to-Broadway-20260423
  // cites "David Finkle, Cote Notices" — actual byline on
  // cotenotices.substack.com/p/rocky-horror-show is David Cote.
  // outlet-registry.json cote-notices.defaultCritic also resolves to David Cote.
  'cote-notices': {
    [normalizeCriticKey('David Finkle')]: 'David Cote',
  },
};

/**
 * Canonicalize a critic's name for a given outlet. Returns the canonical name
 * if the (outletId, criticName) pair is in the mis-attribution map, otherwise
 * returns the original name unchanged.
 *
 * The outletId is expected to be the post-normalization canonical form
 * (same as outlet-registry.json keys). If you pass raw outlet text, resolve it
 * via normalizeOutlet() first.
 *
 * @param {string} outletId  Canonical outletId (e.g., 'cote-notices')
 * @param {string} criticName  Raw critic name from aggregator
 * @returns {{ name: string, canonicalized: boolean, from: string|null }}
 */
function canonicalizeCritic(outletId, criticName) {
  if (!criticName || typeof criticName !== 'string') {
    return { name: criticName, canonicalized: false, from: null };
  }
  if (!outletId || typeof outletId !== 'string') {
    return { name: criticName, canonicalized: false, from: null };
  }
  const map = CRITIC_CANONICAL_MAP[outletId];
  if (!map) return { name: criticName, canonicalized: false, from: null };
  const key = normalizeCriticKey(criticName);
  if (!key) return { name: criticName, canonicalized: false, from: null };
  const canonical = map[key];
  if (!canonical || canonical === criticName) {
    return { name: criticName, canonicalized: false, from: null };
  }
  return { name: canonical, canonicalized: true, from: criticName };
}

module.exports = {
  canonicalizeCritic,
  normalizeCriticKey,
  // Exposed for tests + audit tooling.
  CRITIC_CANONICAL_MAP,
};
