'use strict';
// BRO-7803: merge a validated overlay into the props the show page renders
// from. Pure; used by the client components and by node --test. The static
// props are the default; with no overlay the input is returned untouched.

function breakdown(reviews) {
  return (reviews || []).map((r) => ({ reviewScore: r.reviewScore, verdict: r.verdict }));
}

/** Props for ShowHeroRedesign. */
function applyHeroOverlay(props, overlay) {
  if (!overlay) return props;
  const { view, reviews } = overlay;
  const base = props.show.criticScore || {};
  return {
    ...props,
    show: {
      ...props.show,
      criticScore: {
        ...base,
        score: view.score,
        reviewCount: view.reviewCount,
        tier1Count: view.tier1Count,
        tier2Count: view.tier2Count,
        reviews: breakdown(reviews),
      },
    },
    hasEnoughCriticReviews: !view.showTBD,
    reviewsRemaining: view.reviewsRemaining,
    noReviewsExpected: view.noReviewsExpected,
    criticsTakeMode: view.criticsTakeMode,
    reviewArrival: view.reviewArrival,
    // The age note is only meaningful once a score shows; static value stays otherwise.
    reviewAgeNote: view.showTBD ? null : props.reviewAgeNote,
    hasAudience: view.showTBD ? false : props.hasAudience,
  };
}

/** Score shown in the sticky header: never a number while the page is at TBD. */
function stickyScore(staticScore, overlay) {
  if (!overlay) return staticScore;
  return overlay.view.showTBD ? null : overlay.view.score;
}

/** Row list for ReviewsList: overlay rows replace both the inline and the lazy-loaded rows. */
function reviewListProps(staticProps, overlay) {
  if (!overlay) return staticProps;
  const reviews = overlay.reviews;
  return { ...staticProps, reviews, more: undefined, initialCount: Math.max(staticProps.initialCount || 5, 5) };
}

module.exports = { applyHeroOverlay, stickyScore, reviewListProps, breakdown };
