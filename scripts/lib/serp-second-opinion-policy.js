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

/**
 * BRO-7531: after the first second-opinion vendor came back with nothing, should
 * the other one be asked too? Yes in every case but one. On a press-night flow
 * (emptyAuthoritative === false), when Scrapingdog gave a literal readable empty
 * (sdClean: not a failure, not all-opaque, not off-domain filler) and
 * Bright Data, asked first, really answered (a parsed answer with an organic
 * list, zero results, no unreadable links dropped), ScrapingBee is not asked on
 * this pass. The caller never parks that two-vendor empty in any cache, so the
 * next pass asks every vendor again.
 *
 * Measured 2026-11-15 (three-pass replay of a Broadway press night): 16 of 23
 * ScrapingBee asks followed such a Bright Data empty and found nothing, at 25
 * credits each. Bright Data found reviews Scrapingdog missed, so it stays.
 * Not applied when ScrapingBee is asked first (preferSpeed): that order was not
 * measured. A Bright Data fetch that failed or came back as a short / unparsed
 * page is not an answer, and neither is an all-opaque Scrapingdog reply.
 * Kill switch: SERP_THIRD_OPINION=1 always asks.
 */
function shouldAskOtherSecondOpinion({
  primaryName, primaryResults, primaryStructured = false, tokensDropped = 0,
  sdClean = false, sdAnswered = false, emptyAuthoritative, env = process.env,
} = {}) {
  if (primaryResults && primaryResults.length > 0) return false; // primary found something
  if (env && env.SERP_THIRD_OPINION === '1') return true;
  if (!Array.isArray(primaryResults)) return true; // primary failed
  if (tokensDropped > 0) return true; // unreadable, not empty
  if (emptyAuthoritative !== false) return true; // routine flows: unchanged
  // BRO-6867: any Scrapingdog reply that came back (a clean empty, off-domain
  // filler or an all-opaque list) plus a parsed Bright Data empty is enough.
  // SERP_SB_SECOND_OPINION=1 restores the stricter BRO-7531 rule (clean only).
  const sdOk = sbSecondOpinionRestored(env) ? sdClean === true : sdAnswered === true;
  if (!sdOk) return true; // Scrapingdog failed or was not asked
  if (primaryName !== 'brightdata' || primaryStructured !== true) return true;
  return false;
}

/**
 * BRO-6867 (owner decision 2026-11-17, option A): ScrapingBee is no longer a
 * press-night second opinion. Measured before the change: ~750 ScrapingBee
 * re-asks across 2026-11-05..15 found zero reviews, and of 358 show+outlet
 * pairs it searched 2026-11-15..17, none gained a review it can be credited
 * with. Bright Data stays the second opinion (it finds reviews Scrapingdog
 * misses, BRO-7531); ScrapingBee stays the backup when Bright Data fails, and
 * the 5% audit sample (shouldAuditThirdOpinion) still asks it.
 */
function sbSecondOpinionRestored(env = process.env) {
  return !!env && env.SERP_SB_SECOND_OPINION === '1';
}

/**
 * Chain order for the second-opinion vendors. On a press-night flow whose
 * Scrapingdog request came back (sdAnswered), Bright Data goes first even when
 * the caller asked for speed, so ScrapingBee is only reached when Bright Data
 * fails or the audit sample fires. Every other case keeps the caller's order.
 * Returns the effective preferSpeed flag for serpChainOrder.
 */
function effectivePreferSpeed({ preferSpeed, emptyAuthoritative, sdAnswered, env = process.env } = {}) {
  if (!preferSpeed) return false;
  if (emptyAuthoritative === false && sdAnswered === true && !sbSecondOpinionRestored(env)) return false;
  return true;
}

/**
 * A Bright Data reply counts as a real answer only when it is the parsed search
 * page: an organic list plus the "general" block that carries the query it ran.
 * Anything else (raw HTML, a short page, a bare object) is not an answer.
 */
function isParsedSerpAnswer(data) {
  return !!data && typeof data === 'object' && Array.isArray(data.organic)
    && !!data.general && typeof data.general === 'object';
}

/**
 * Audit sample for the skip above: this share of skipped asks goes out anyway.
 * Default 5%. Env SERP_THIRD_OPINION_AUDIT_RATE (0..1) overrides.
 */
function shouldAuditThirdOpinion(rand = Math.random, env = process.env) {
  const raw = env && env.SERP_THIRD_OPINION_AUDIT_RATE;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  const rate = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.05;
  return rand() < rate;
}

module.exports = {
  isSlowTrickleMarket, serpSecondOpinionForShow, shouldSkipSecondOpinion,
  shouldReaskEmptyWithoutSecondOpinion, shouldEscalateOffDomainAnswer,
  shouldAskOtherSecondOpinion, shouldAuditThirdOpinion, isParsedSerpAnswer,
  sbSecondOpinionRestored, effectivePreferSpeed,
};
