/**
 * Pure policy (BRO-7531): does a press-night SERP query for this show need a
 * second provider's opinion after Scrapingdog answered "0 results"?
 *
 * emptyAuthoritative:false (BRO-5914) does two things on press night: it never
 * caches an empty answer, and it re-asks ScrapingBee / Bright Data after a
 * clean Scrapingdog empty. The first is what fixed the 860 miss. The second
 * costs 25 ScrapingBee credits a query and, across ten days of gather logs
 * (2026-11-05..15, ~750 such re-asks), found zero reviews.
 *
 * Off-Broadway and off-West-End keep the "never cache" half and drop the
 * paid re-ask (they get one cheap same-vendor re-ask instead, see
 * shouldReaskEmptyWithoutSecondOpinion): their reviews trickle in over days, and one provider was already
 * the stated policy there (see isBrightDataAllowedForShow in
 * opening-night-poller.js, which uses the same category helper). Scrapingdog
 * is still re-asked every tick, and a Scrapingdog FAILURE (null) or an
 * all-opaque answer still fails over to ScrapingBee / Bright Data.
 *
 * Broadway, West End and unknown categories keep the second opinion: a show
 * can ship with a null category on opening day, and over-asking is the safe
 * default.
 *
 * Kill switch: SERP_OB_SECOND_OPINION=1 restores the re-ask everywhere.
 */

/** Markets whose reviews arrive slowly enough that one SERP provider is enough. */
function isSlowTrickleMarket(show) {
  const category = (show && (show.category || show.market)) || '';
  return category === 'off-broadway' || category === 'off-west-end';
}

function serpSecondOpinionForShow(show) {
  if (process.env.SERP_OB_SECOND_OPINION === '1') return true;
  return !isSlowTrickleMarket(show);
}

/**
 * Chain decision: Scrapingdog's own request succeeded with a clean empty, the
 * caller said empties are not final (never cache) AND opted out of the second
 * opinion. Then the empty stands for this tick only.
 * opaqueDropped > 0 means the [] came from dropping unreadable links, which is
 * not "nothing found", so the chain must still escalate.
 */
function shouldSkipSecondOpinion(sdResults, emptyAuthoritative, secondOpinion, opaqueDropped = 0) {
  return Array.isArray(sdResults) && sdResults.length === 0
    && emptyAuthoritative === false && secondOpinion === false && !(opaqueDropped > 0);
}

/**
 * A market that dropped the ScrapingBee / Bright Data second opinion still gets
 * one same-vendor re-ask of a clean empty (5 Scrapingdog credits instead of 25
 * ScrapingBee). Scrapingdog's empties are not reliable: queries with certain
 * matches came back empty on 23 of 59 repeat asks (2026-11-15), so a single
 * empty must not stand alone as this tick's answer.
 * Kill switch: SERP_SITE_REASK=0 (the same switch as the ignored-site: re-ask).
 */
function shouldReaskEmptyWithoutSecondOpinion(sdResults, emptyAuthoritative, secondOpinion, opaqueDropped = 0, env = process.env) {
  if (env && env.SERP_SITE_REASK === '0') return false;
  return shouldSkipSecondOpinion(sdResults, emptyAuthoritative, secondOpinion, opaqueDropped);
}

/**
 * Scrapingdog answered a site: query with off-domain results only (after its
 * one re-ask). On a press-night flow that keeps the second opinion, that is an
 * empty in disguise and must reach ScrapingBee / Bright Data exactly like a
 * literal empty does. Markets without a second opinion keep the answer.
 */
function shouldEscalateOffDomainAnswer(offDomainOnly, emptyAuthoritative, secondOpinion) {
  return offDomainOnly === true && emptyAuthoritative === false && secondOpinion !== false;
}

module.exports = {
  isSlowTrickleMarket, serpSecondOpinionForShow, shouldSkipSecondOpinion,
  shouldReaskEmptyWithoutSecondOpinion, shouldEscalateOffDomainAnswer,
};
