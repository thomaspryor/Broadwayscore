'use strict';
/**
 * gather-default-critic.js (BRO-8393): which byline gather-reviews.js may stamp
 * on a SERP / site-search hit before the page is read.
 *
 * loadOutlets() builds outlet lists two ways. The registry path (Broadway,
 * off-Broadway, West End) fills `critics` from the registry's vetted
 * defaultCritic / defaultCritics, so a one-name list really means "this outlet
 * has one critic". The legacy path (every other category: regional, tour)
 * reads scripts/config/critic-outlets.json, where `critics` is just the NYC
 * critic the list was written around (Guardian → Alexis Soloski, Time Out →
 * Adam Feldman, BroadwayWorld → Richard Sasanow). Treating that as a default
 * byline credited a Sydney Guardian review (Steve Dow) to Soloski and a
 * Sydney BroadwayWorld review (Jade Kops) to Sasanow.
 *
 * Only a list marked `criticsAreDefaults: true` may name the byline; anything
 * else stays 'Unknown' so the page byline (collect / _pending drain) or the
 * registry defaultCritic promotion in saveReview decides.
 */
function defaultCriticForOutlet(outlet) {
  if (!outlet || outlet.criticsAreDefaults !== true) return 'Unknown';
  const critics = Array.isArray(outlet.critics) ? outlet.critics : [];
  return critics.length === 1 && critics[0] ? critics[0] : 'Unknown';
}

module.exports = { defaultCriticForOutlet };
