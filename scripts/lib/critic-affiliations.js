'use strict';

// BRO-6027: explicit contradictions must not learn from the same bad rows
// they audit. Corpus frequency and fetched text without a byline can both
// incorrectly establish an affiliation. Keep this list narrow: absence from
// knownOutlets is not evidence that a freelancer never wrote for an outlet.
const CONTRADICTED_AFFILIATIONS = {
  'david-rooney': {
    theatermania: 'David Rooney did not write for TheaterMania (BRO-6027; BRO-4889). Verify the article byline.',
  },
};

/** Advisory flags over the canonical critic/outlet keys from critic-review-scan. */
function findAffiliationFlags(critics) {
  const flags = [];
  for (const [criticSlug, critic] of Object.entries(critics)) {
    const contradictions = CONTRADICTED_AFFILIATIONS[criticSlug];
    if (!contradictions) continue;
    for (const review of critic.reviews) {
      const reason = contradictions[review.outlet];
      if (!reason || review.nonReview) continue;
      flags.push({
        critic: critic.displayName,
        criticSlug,
        outlet: review.outlet,
        showId: review.showId,
        file: review.file,
        reason,
      });
    }
  }
  return flags.sort((a, b) => `${a.criticSlug}/${a.showId}/${a.file}`.localeCompare(`${b.criticSlug}/${b.showId}/${b.file}`));
}

module.exports = { findAffiliationFlags };
