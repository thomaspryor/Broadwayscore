/**
 * Decides whether a /cast/[slug] page has enough unique content to be indexed.
 *
 * Google Search Console (2026-10-15, BRO-5399) reported "Soft 404" and
 * "Duplicate, Google chose different canonical". A live sample of /cast pages
 * showed about a third are a single credit with no critic score: roughly 270
 * characters of unique text on a shared template. Google treats that shape as a
 * soft 404 and clusters the pages as near-duplicates.
 *
 * Thin pages stay reachable (links and search keep working) but are noindex,
 * follow and are left out of the sitemap. They flip back automatically once the
 * actor gains a second credit, a scored show or a Tony nomination.
 */

function isThinActorProfile(profile, tonyNominations = 0, hasSearchLanding = false, singleCreditIsThin = false) {
  if (!profile) return true;
  // A page with real search entries in the last 90 days is never noindexed (BRO-5969).
  if (hasSearchLanding) return false;
  // The page renders Tony nominations/wins, so it is not thin (161 nominees and
  // 29 winners were otherwise one-credit, unscored pre-2005 actors).
  if (tonyNominations > 0) return false;
  const credits = profile.showCount || 0;
  // BRO-5969 (/cast only): a single credit is thin even when that show has a
  // score (70 of 165 sampled /cast pages were 1-credit, 30-55 words). Tony
  // nominees and pages with search entries are kept above.
  if (singleCreditIsThin) return credits <= 1;
  const scored = profile.scoredShowCount || 0;
  // avgScore is only ever set when scored > 0; kept so a stray non-null score can never be noindexed
  return credits <= 1 && scored === 0 && profile.avgScore == null;
}

module.exports = { isThinActorProfile };
