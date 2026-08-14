/**
 * Wrong-Production Auto-Clear Decision
 *
 * Pure decision functions for deciding whether the rebuild's auto-clear
 * paths should strip wrongProduction / wrongShow flags from a review file.
 *
 * Background: rebuild-all-reviews.js has auto-clear paths that strip
 * wrongProduction when allowEarlyDate or allowCrossMarket is true.
 * Without guards, these paths strip flags even when the user/audit/CV
 * explicitly set wrongProduction with a reason — re-introducing
 * cross-market contamination on every rebuild.
 *
 * Used by:
 * - scripts/rebuild-all-reviews.js (main rebuild loop, allowEarlyDate auto-clear)
 * - scripts/flag-wrong-production-by-date.js (Date-guard pre-flag check)
 * - tests/unit/wrong-production-autoclear.test.mjs
 */

const { parseDate } = require('./date-utils');

/**
 * Decide whether a review's publishDate falls inside any of the show's
 * prior-run windows (Phase 1 production-continuity model).
 *
 * Each priorRun describes a previous run of the same artistic production
 * (workshop → mainstage transfer, return engagement, etc.). A review whose
 * publishDate sits inside priorRun.openingDate..closingDate is legitimate
 * coverage of an earlier run of THIS production and must not be flagged
 * wrongProduction by date-only guards.
 *
 * Defaults / edge cases:
 *  - reviewDate / priorRuns missing or empty → false (caller falls back to
 *    the existing 90-day pre-opening guard).
 *  - openingDate missing / unparseable on a priorRun entry → that entry is
 *    skipped (other entries still evaluated).
 *  - closingDate missing on a priorRun → window extends 180 days past
 *    openingDate (limited-run default; matches OB lab/showcase typical run).
 *  - Comparison is inclusive of both bounds and date-only (UTC midnight).
 *
 * @param {Date|string|null} reviewDate - Review publish date (Date or ISO/parseable string)
 * @param {Array<{openingDate?: string, closingDate?: string, venue?: string}>} priorRuns
 * @returns {boolean}
 */
function isWithinPriorRun(reviewDate, priorRuns) {
  return !!findMatchingPriorRun(reviewDate, priorRuns);
}

/**
 * Same window logic as isWithinPriorRun, but returns the MATCHED priorRun
 * entry (not just a boolean) — callers that need to know which run a review
 * belongs to (e.g. to judge the review's market against that run's OWN venue
 * rather than the current run's) use this instead of re-deriving the window
 * math. isWithinPriorRun is defined in terms of this so the two can never
 * drift apart.
 *
 * @param {Date|string|null} reviewDate
 * @param {Array<{openingDate?: string, closingDate?: string, venue?: string}>} priorRuns
 * @returns {{openingDate?: string, closingDate?: string, venue?: string}|null}
 */
function findMatchingPriorRun(reviewDate, priorRuns) {
  if (!reviewDate || !Array.isArray(priorRuns) || priorRuns.length === 0) return null;
  const rd = reviewDate instanceof Date ? reviewDate : parseDate(reviewDate);
  if (!rd || isNaN(rd.getTime())) return null;
  const rdMs = rd.getTime();

  for (const run of priorRuns) {
    if (!run || !run.openingDate) continue;
    const open = parseDate(run.openingDate);
    if (!open || isNaN(open.getTime())) continue;
    let close;
    if (run.closingDate) {
      close = parseDate(run.closingDate);
      if (!close || isNaN(close.getTime())) close = undefined;
    }
    if (!close) {
      close = new Date(open.getTime());
      close.setUTCDate(close.getUTCDate() + 180);
    }
    if (rdMs >= open.getTime() && rdMs <= close.getTime()) return run;
  }
  return null;
}

/**
 * Decide whether a review's publishDate falls inside any of the show's
 * declared tourLegs windows (current-touring-production continuity model).
 *
 * Each tourLeg describes a venue stop of the CURRENT touring production —
 * unlike priorRuns (a distinct EARLIER production), a tourLeg is part of the
 * same ongoing run, just in a different city. A review whose publishDate sits
 * inside tourLeg.startDate..endDate is legitimate coverage of this production
 * at that stop and must not be flagged wrongProduction by date-only guards.
 *
 * Same defaults/edge-cases as isWithinPriorRun: missing endDate defaults to
 * startDate + 180 days; comparison is inclusive of both bounds, date-only.
 *
 * @param {Date|string|null} reviewDate
 * @param {Array<{startDate?: string, endDate?: string, venue?: string}>} tourLegs
 * @returns {boolean}
 */
function isWithinTourLeg(reviewDate, tourLegs) {
  if (!reviewDate || !Array.isArray(tourLegs) || tourLegs.length === 0) return false;
  const rd = reviewDate instanceof Date ? reviewDate : parseDate(reviewDate);
  if (!rd || isNaN(rd.getTime())) return false;
  const rdMs = rd.getTime();

  for (const leg of tourLegs) {
    if (!leg || !leg.startDate) continue;
    const start = parseDate(leg.startDate);
    if (!start || isNaN(start.getTime())) continue;
    let end;
    if (leg.endDate) {
      end = parseDate(leg.endDate);
      if (!end || isNaN(end.getTime())) end = undefined;
    }
    if (!end) {
      end = new Date(start.getTime());
      end.setUTCDate(end.getUTCDate() + 180);
    }
    if (rdMs >= start.getTime() && rdMs <= end.getTime()) return true;
  }
  return false;
}

/**
 * True when a show declares at least one usable tourLegs window (a venue stop
 * of the current touring production). "Usable" means at least one entry has
 * a startDate. Mirrors hasDeclaredPriorRuns.
 *
 * @param {{ tourLegs?: Array<{startDate?: string}> }} show
 * @returns {boolean}
 */
function hasDeclaredTourLegs(show) {
  return !!(
    show &&
    Array.isArray(show.tourLegs) &&
    show.tourLegs.some((l) => l && l.startDate)
  );
}

/**
 * True when a show declares at least one usable priorRuns window (a previous
 * run of the same artistic production: workshop→mainstage, return engagement,
 * or a venue transfer). "Usable" means at least one entry has an openingDate.
 *
 * Discovery callers use this to widen review-gathering for a show that is
 * technically still in `previews` for its CURRENT engagement but was already
 * reviewed during a declared prior run — otherwise the previews-skip drops
 * legitimate transfer reviews on the floor (the off-Broadway transfer blind
 * spot: a hit at a small house moves to a bigger one and the original-run
 * reviews are never inherited). Per-review date gating still happens downstream
 * via isWithinPriorRun().
 *
 * @param {{ priorRuns?: Array<{openingDate?: string}> }} show
 * @returns {boolean}
 */
function hasDeclaredPriorRuns(show) {
  return !!(
    show &&
    Array.isArray(show.priorRuns) &&
    show.priorRuns.some((r) => r && r.openingDate)
  );
}

/**
 * Decide whether an existing wrongProduction flag — set by the date-only
 * Pre-opening guard or Date guard — should be auto-cleared because the
 * show now declares a priorRuns window that covers the review's date.
 *
 * Returns true ONLY if all conditions hold:
 *  - data.wrongProduction === true
 *  - data.wrongProductionNote starts with "Pre-opening guard" OR "Date guard"
 *    (the auto-flagger family — never strips flags from manual / CV / cross-market)
 *  - data.publishDate parses
 *  - show.priorRuns covers data.publishDate
 *  - No data.wrongProductionReason (manual / audit reason)
 *  - No high-confidence CV wrongProduction or wrongArticle
 *
 * Mirrors the safety guards used by shouldAutoClearWrongProductionUrlYear.
 *
 * @param {object} data - The review JSON object
 * @param {{ priorRuns?: Array<object> }} show - The show config
 * @returns {boolean}
 */
// Auto-set wrongProductionReason values that are date-only (NOT operator-set).
// These are written by date-based setters and are valid candidates for priorRuns
// auto-clear. Anything not in this set (and not in the auto-prefix list below)
// is treated as a manual reason and protected.
const DATE_ONLY_AUTO_REASONS = new Set([
  'anticipatory_pre_opening_post', // collect-review-texts.js anticipatory gate
]);
// Auto-set wrongProductionReason PREFIXES that priorRuns is allowed to override.
// CV-promoted reasons specifically include "CV identifies a different venue/run"
// — exactly what an operator-declared priorRun overrides. Operator-trust over CV
// is the Phase 1 design (parent card 351637c5-416f-81fe).
const AUTO_REASON_PREFIXES = [
  'CV-promoted:',
  'CV-low-but-strong-signal:',
];
// Auto-set wrongProductionReason PATTERNS (regex) that priorRuns may override.
// These are pure date/year-mismatch reverifications — the review is flagged
// SOLELY because its year doesn't match the current engagement's year, which
// is exactly the false signal a declared priorRun corrects. Kept narrow (the
// specific year-gap phrasing) so non-date Haiku verdicts stay protected.
const AUTO_REASON_REGEXES = [
  /^Haiku reverify: publishDate \d{4} vs showId year \d{4}/i,
];
// Date-only auto-flag NOTE/REASON prefixes that priorRuns is allowed to override:
//  - "Pre-opening guard" (rebuild-all-reviews.js inclusion + flag pass)
//  - "Date guard" (flag-wrong-production-by-date.js standalone)
//  - "Auto-flagged" (gather-reviews.js Broadway-only ingest guard)
//  - "Review published" (rebuild-all-reviews.js per-review skip-pre-opening writer)
const DATE_GUARD_PREFIXES = [
  'Pre-opening guard',
  'Date guard',
  'Auto-flagged',
  'Review published',
];
const startsWithAny = (s, prefixes) => prefixes.some((p) => s.startsWith(p));

/**
 * Best effort to recover the date a date-guard flagger acted on. Premiere-era
 * review files frequently carry a null or year-less `publishDate` (e.g.
 * "October 20"), but the guard that flagged them embeds the real ISO date in
 * its note/reason ("review dated 2022-10-19 is 90+ days before…"). Falling
 * back to that recorded date lets a declared priorRuns window match.
 *
 * @param {object} data - review JSON
 * @returns {Date|null}
 */
function effectiveFlagDate(data) {
  if (data.publishDate) {
    const pd = parseDate(data.publishDate);
    if (pd && !isNaN(pd.getTime())) return pd;
  }
  const blob = `${data.wrongProductionNote || ''} ${data.wrongProductionReason || ''}`;
  const m = blob.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) {
    const d = parseDate(m[1]);
    if (d && !isNaN(d.getTime())) return d;
  }
  return null;
}

function shouldAutoClearWrongProductionPriorRun(data, show) {
  if (!data || data.wrongProduction !== true) return false;
  if (!show || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return false;
  const note = data.wrongProductionNote || '';
  const reason = data.wrongProductionReason || '';
  // Date-only auto-flag provenance can live in EITHER field — different setters
  // write the guard text to wrongProductionNote (rebuild/date-guard) or to
  // wrongProductionReason (some reverify paths). Honor both.
  const isDateOnlyAutoFlag = startsWithAny(note, DATE_GUARD_PREFIXES)
    || startsWithAny(reason, DATE_GUARD_PREFIXES);
  // The anticipatory ingest gate + CV-promotion + year-gap reverify paths write
  // ONLY wrongProductionReason. Recognize their auto-set values as override-eligible.
  const isAutoReason = DATE_ONLY_AUTO_REASONS.has(reason)
    || AUTO_REASON_PREFIXES.some((p) => reason.startsWith(p))
    || AUTO_REASON_REGEXES.some((re) => re.test(reason));
  if (!isDateOnlyAutoFlag && !isAutoReason) return false;
  const effDate = effectiveFlagDate(data);
  if (!effDate || !isWithinPriorRun(effDate, show.priorRuns)) return false;
  // Treat reason as "manual" only when it's not a recognized auto signal AND
  // not a date-guard-prefixed reason. Protects audit/operator reasons.
  const reasonIsAuto = isAutoReason || startsWithAny(reason, DATE_GUARD_PREFIXES);
  const hasManualReason = !!reason && !reasonIsAuto;
  // CV-confirmed gate: still respect high-conf CV wrongArticle (entirely
  // different show, not just different production). Phase 1 trusts priorRuns
  // over CV's wrongProduction (venue/date match) but NOT over wrongArticle.
  const cvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  // Defense-in-depth (#1156 ship-check): structurally, ensemble rejections
  // never populate wrongProductionNote/Reason with a DATE_GUARD_PREFIXES/
  // AUTO_REASON value, so this can't currently overlap with an ensemble
  // verdict — but check explicitly rather than relying on that coincidence.
  if (hasEnsembleConsensus(data, 'wrong_production')) return false;
  return !hasManualReason && !cvConfirmedWrongArticle;
}

/**
 * Same decision as shouldAutoClearWrongProductionPriorRun, but for a declared
 * tourLegs window (current-production continuity) instead of priorRuns (a
 * distinct earlier production). Kept as a SEPARATE function — mirroring
 * rather than merging with the priorRuns version — because the two fields
 * describe different things and a future divergence (e.g. tourLegs someday
 * gaining its own manual-reason vocabulary) should not require re-splitting
 * a merged predicate.
 */
function shouldAutoClearWrongProductionTourLeg(data, show) {
  if (!data || data.wrongProduction !== true) return false;
  if (!show || !Array.isArray(show.tourLegs) || show.tourLegs.length === 0) return false;
  const note = data.wrongProductionNote || '';
  const reason = data.wrongProductionReason || '';
  const isDateOnlyAutoFlag = startsWithAny(note, DATE_GUARD_PREFIXES)
    || startsWithAny(reason, DATE_GUARD_PREFIXES);
  const isAutoReason = DATE_ONLY_AUTO_REASONS.has(reason)
    || AUTO_REASON_PREFIXES.some((p) => reason.startsWith(p))
    || AUTO_REASON_REGEXES.some((re) => re.test(reason));
  if (!isDateOnlyAutoFlag && !isAutoReason) return false;
  const effDate = effectiveFlagDate(data);
  if (!effDate || !isWithinTourLeg(effDate, show.tourLegs)) return false;
  const reasonIsAuto = isAutoReason || startsWithAny(reason, DATE_GUARD_PREFIXES);
  const hasManualReason = !!reason && !reasonIsAuto;
  const cvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  // Defense-in-depth (#1156 ship-check) — see shouldAutoClearWrongProductionPriorRun.
  if (hasEnsembleConsensus(data, 'wrong_production')) return false;
  return !hasManualReason && !cvConfirmedWrongArticle;
}

/**
 * Decide whether a wrongProduction/wrongShow-rejected file carries a
 * strong-evidence ensemble verdict that no domain/market heuristic should be
 * allowed to override.
 *
 * THE single definition of "the ensemble agreed", consulted by all six
 * auto-clear predicates in this file plus audit-wrongshow-autoclear-conflicts.js
 * and autoclear-vs-ensemble-scan.js. Two parallel #1146/#1156 sessions each
 * landed a version of this predicate (hasEnsembleConsensus here,
 * hasEnsembleRejection on the coverage-defects branch) with identical
 * behaviour; they were collapsed into this one at merge (2026-08-09). Do not
 * reintroduce a second copy — a divergence between them is exactly the kind of
 * quiet inconsistency that lets an auto-clear overrule the models again.
 *
 * Background (Notion 3b7637c5-416f-810a, task #1146; generalized to
 * wrongProduction under #1156): the rebuild's UK/major-outlet and
 * allowCrossMarket/allowEarlyDate auto-clear paths strip wrongProduction/
 * wrongShow unconditionally once their domain/market conditions match —
 * including when scripts/llm-scoring/index.ts already ran 3 independent
 * models (claude + openai + gemini) against the actual fetched text and >=2
 * of them independently rejected it. ensemble-scorer.ts's combineOutcomes()
 * only produces a top-level `rejected` verdict (and therefore only ever
 * writes rejectionReason='wrong_production'|'wrong_show' + rejectedBy=
 * 'ensemble-scoreability-check') when `rejections.length >= 2` — so the mere
 * presence of that pairing on disk is itself the >=2/3-model-agreement
 * receipt; rejectionReasoning's `model: reasoning; model: reasoning` shape
 * is the paper trail, counted here defensively in case some other writer
 * ever reuses rejectedBy='ensemble-scoreability-check' without going through
 * combineOutcomes.
 *
 * A blanket "UK outlet URL on a London show can't be wrong-show" heuristic
 * is a reasonable prior when nothing else is known, but it is weaker
 * evidence than 2-3 models independently reading the fetched text and naming
 * a specific different production (romeo-and-juliet-west-end-2026's
 * london-theatre--holly-omahony.json: url pointed at the R&J page, all 3
 * models identified the fetched text as a Noughts & Crosses review).
 *
 * @param {object} data - the review JSON object
 * @param {'wrong_production'|'wrong_show'} reason
 * @returns {boolean}
 */
// The 4 model tags ensemble-scorer.ts's combineOutcomes() ever writes
// (results.find(r => r.model === 'claude' | 'openai' | 'gemini' | 'kimi')).
// Anchoring to this literal set — instead of a generic `[\w-]+:` match after
// splitting rejectionReasoning on ';' — matters because a single model's own
// free-text reasoning can legitimately contain a ';' or a digit+colon
// (e.g. "...mentions an 8:00pm curtain; not the same show"), which a naive
// split+regex miscounts as a second model's segment. ship-check finding
// (task #1146): verified `8:00pm` alone satisfied the old `[\w-]+\s*:` test.
const ENSEMBLE_MODEL_TAG_RE = /(?:^|;\s*)(claude|openai|gemini|kimi)\s*:/gi;

function hasEnsembleConsensus(data, reason) {
  if (!data) return false;
  if (data.rejectionReason !== reason) return false;
  if (data.rejectedBy !== 'ensemble-scoreability-check') return false;
  const reasoning = data.rejectionReasoning;
  if (!reasoning || typeof reasoning !== 'string') return false;
  const models = new Set();
  ENSEMBLE_MODEL_TAG_RE.lastIndex = 0;
  let match;
  while ((match = ENSEMBLE_MODEL_TAG_RE.exec(reasoning))) {
    models.add(match[1].toLowerCase());
  }
  return models.size >= 2;
}

/**
 * Decide whether a review's fetched text is too stale to vouch for a URL
 * that was later corrected/rewritten onto a different article.
 *
 * Background (task #1146): a URL rewrite (urlCorrectedFrom / urlUpdatedFrom
 * / _urlChangedClear) records that the file's `url` now points at a
 * different article than when `fullText` was fetched. If `textFetchedAt`
 * predates the rewrite, the on-disk text was never (re-)fetched from the
 * corrected URL — it's still whatever the OLD url returned — so the file's
 * content cannot be used as evidence that the NEW url's show is correct.
 * (the-devil-wears-prada-west-end-2024's times-uk--clive-davis.json:
 * urlCorrectedFrom + urlUpdatedFrom both present, textFetchedAt
 * 2026-02-26 predates urlUpdatedAt 2026-04-03 — the text on disk is a
 * Sondheim/Bridge Theatre review that was never re-fetched after the URL
 * was corrected to the Devil Wears Prada page.)
 *
 * @param {object} data - the review JSON object
 * @returns {boolean}
 */
function isTextStaleRelativeToUrlRewrite(data) {
  if (!data) return false;
  const hasUrlRewrite = !!(data.urlCorrectedFrom || data.urlUpdatedFrom || data._urlChangedClear);
  if (!hasUrlRewrite) return false;
  const rewriteAt = data.urlUpdatedAt || (data._urlChangedClear && data._urlChangedClear.at);
  if (!rewriteAt || !data.textFetchedAt) return false;
  // NOT parseDate() here — it truncates to UTC midnight (date-utils.js:
  // `new Date(normalized + 'T00:00:00Z')`), which would silently collapse
  // same-day fetch-before-rewrite gaps to equal timestamps. urlUpdatedAt /
  // textFetchedAt are always full ISO instants (e.g.
  // "2026-04-03T17:01:15.864Z"), so compare them directly. ship-check
  // finding (task #1146).
  const rewriteMs = new Date(rewriteAt).getTime();
  const fetchedMs = new Date(data.textFetchedAt).getTime();
  if (isNaN(rewriteMs) || isNaN(fetchedMs)) return false;
  return fetchedMs < rewriteMs;
}

/**
 * Decide whether the allowEarlyDate/allowCrossMarket auto-clear should
 * strip wrongProduction from a review file.
 *
 * Returns true ONLY if both conditions hold:
 *   - One of allowEarlyDate / allowCrossMarket is true (user explicit override)
 *   - There is NO explicit wrongProductionReason, NO high-confidence CV signal,
 *     and NO unanimous ensemble wrong_production rejection (so the flag is
 *     safe to clear)
 *
 * @param {object} data - The review JSON object
 * @returns {boolean} - true if it's safe to delete wrongProduction
 */
function shouldAutoClearWrongProduction(data) {
  if (data.wrongProduction !== true) return false;
  if (!data.allowEarlyDate && !data.allowCrossMarket) return false;
  const hasManualReason = !!data.wrongProductionReason;
  const cvConfirmedWrong = data.contentVerification?.wrongProduction === true
    && data.contentVerification?.confidence === 'high';
  if (hasEnsembleConsensus(data, 'wrong_production')) return false;
  if (isTextStaleRelativeToUrlRewrite(data)) return false;
  return !hasManualReason && !cvConfirmedWrong;
}

/**
 * Same logic for wrongShow flag (parallel auto-clear path).
 *
 * @param {object} data
 * @returns {boolean}
 */
function shouldAutoClearWrongShow(data) {
  if (data.wrongShow !== true) return false;
  if (!data.allowEarlyDate && !data.allowCrossMarket) return false;
  const hasManualReason = !!data.wrongShowReason;
  const cvConfirmedWrong = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  if (hasEnsembleConsensus(data, 'wrong_show')) return false;
  if (isTextStaleRelativeToUrlRewrite(data)) return false;
  return !hasManualReason && !cvConfirmedWrong;
}

/**
 * Decide whether the WE/OB URL-year auto-clear path should strip wrongProduction.
 *
 * The URL-year guard sets wrongProduction=true when a review URL contains a year
 * that doesn't match the show's season. For West End and off-Broadway shows this
 * is a known false-positive source (transfers, unconventional year tags) and the
 * rebuild exempts them — but only if the flag wasn't set for some OTHER explicit
 * reason (manual audit, high-confidence CV, a show-listing/aggregate URL).
 *
 * Callers pass `isLondonOrOffBroadway` so this lib stays decoupled from
 * isLondonMarket() / show-category imports. `cvBlocksClear` and
 * `isShowListingUrl` are computed by the caller (rebuild-all-reviews.js) —
 * same ctx shape as the sibling shouldAutoClearWrongProductionUkDualMarket —
 * so this lib doesn't need to require review-guards.js / cross-production-guards.js.
 *
 * @param {object} data
 * @param {object} ctx
 * @param {boolean} ctx.isLondonOrOffBroadway - true if showCat is london/off-broadway
 * @param {boolean} ctx.cvBlocksClear - cvBlocksUkWrongProductionAutoClear(data.contentVerification)
 * @param {boolean} ctx.isShowListingUrl - true if data.url is a /shows/ aggregate/listing page
 * @returns {boolean}
 */
function shouldAutoClearWrongProductionUrlYear(data, { isLondonOrOffBroadway, cvBlocksClear, isShowListingUrl } = {}) {
  if (data.wrongProduction !== true) return false;
  if (!data.wrongProductionNote || !data.wrongProductionNote.includes('URL contains year')) return false;
  if (!isLondonOrOffBroadway) return false;
  if (cvBlocksClear) return false;
  if (isShowListingUrl) return false;
  if (data.wrongProductionReason) return false;
  if (hasEnsembleConsensus(data, 'wrong_production')) return false;
  if (isTextStaleRelativeToUrlRewrite(data)) return false;
  return true;
}

/**
 * Decide whether the UK-URL wrongShow auto-clear path should strip wrongShow.
 *
 * When wrongShow was set on a London-market file whose URL is a UK outlet,
 * it's almost always an LLM false-positive (UK outlets only cover London
 * theatre). But: respect manual wrongShowReason, CV-confirmed wrongArticle,
 * and date-mismatches (review >90 days before open = prior production).
 *
 * Callers pass `isLondonMarketShow`, `isUkOutletUrl`, `dateMismatchOver90d`
 * so this lib stays decoupled from venue-classification / parseDate.
 *
 * @param {object} data
 * @param {object} ctx
 * @param {boolean} ctx.isLondonMarketShow
 * @param {boolean} ctx.isUkOutletUrl
 * @param {boolean} ctx.dateMismatchOver90d
 * @returns {boolean}
 */
function shouldAutoClearWrongShowUkUrl(data, { isLondonMarketShow, isUkOutletUrl, dateMismatchOver90d } = {}) {
  if (data.wrongShow !== true) return false;
  if (!isLondonMarketShow) return false;
  if (!isUkOutletUrl) return false;
  if (dateMismatchOver90d) return false;
  const isWrongArticle = data.contentVerification?.wrongArticle === true;
  const hasManualReason = !!data.wrongShowReason;
  if (hasEnsembleConsensus(data, 'wrong_show')) return false;
  if (isTextStaleRelativeToUrlRewrite(data)) return false;
  return !isWrongArticle && !hasManualReason;
}

/**
 * Decide whether a "Dateless revival guard" wrongProduction flag should be
 * auto-cleared. That guard (scripts/lib/date-guard.js → evaluateDatelessRevivalGuard)
 * holds a review that has NO usable date on a recent revival title. It is a
 * provisional HOLD, not a verdict: the moment the review gains a usable date
 * (backfill / re-scrape) the proper dated guard should own the decision, and an
 * explicit human override must always win. This strips only our own flag —
 * recognised by its note prefix or reason — never a manual/CV/cross-market flag.
 *
 * @param {object} data - the review JSON object
 * @param {object} ctx
 * @param {boolean} ctx.hasUsableDate - true if the review now has a usable date
 *   (parsed publishDate or YYYYMMDD URL date)
 * @returns {boolean}
 */
function shouldAutoClearDatelessRevival(data, { hasUsableDate } = {}) {
  if (!data || data.wrongProduction !== true) return false;
  const note = data.wrongProductionNote || '';
  const reason = data.wrongProductionReason || '';
  const isOurs = note.startsWith('Dateless revival guard') || reason === 'dateless-revival';
  if (!isOurs) return false;
  const humanOverride = !!data.allowEarlyDate
    || !!data.wrongProductionManualClear
    || data.humanReviewedWrongProduction === true;
  return !!hasUsableDate || humanOverride;
}

/**
 * Decide whether a STALE dated pre-opening guard wrongProduction flag should be
 * auto-cleared because the review's CURRENT date now falls inside the show's
 * valid window.
 *
 * Background (2026-06-28): the rebuild's dated pre-opening guard sets
 * wrongProduction + a `Pre-opening guard: ...` note when a review's date is 90+
 * days before the show. Once flagged, the rebuild short-circuits on
 * `d.wrongProduction` and NEVER re-evaluates the guard — so when the date is
 * later corrected to an in-window date (adjudication / re-scrape), the stale
 * flag silently keeps a genuine review out of the rebuild forever. 145 corpus-
 * wide, including major-outlet reviews (all-my-sons-west-end-2025 Guardian/Arifa
 * Akbar: a real 2025-11-22 review held by a long-gone 2025-07-01 date; Tina 2019
 * WashPost/NYPost/NYDN; Torch Song 2018 Vulture/EW).
 *
 * SAFETY: only clears flags whose note proves the DATED guard set them
 * (note begins `Pre-opening guard:`). Operator / CV / cross-market / dateless-
 * revival / manual wrongProduction is never matched. The caller computes the
 * in-window verdict via date-guard.evaluateDateGuard on the review's resolved
 * date and passes it as `nowInWindow` — keeping this module free of a circular
 * require on date-guard (which already requires isWithinPriorRun from here).
 *
 * @param {object} data - the review JSON object
 * @param {object} ctx
 * @param {boolean} ctx.nowInWindow - true if evaluateDateGuard(...).flag === false
 *   for the review's current resolved date (date now inside the valid window)
 * @returns {boolean}
 */
function shouldAutoClearStaleDateGuard(data, { nowInWindow } = {}) {
  if (!data || data.wrongProduction !== true) return false;
  const note = data.wrongProductionNote || '';
  if (!note.startsWith('Pre-opening guard:')) return false;
  return nowInWindow === true;
}

/**
 * Decide whether the rebuild's UK/dual-market outlet auto-clear path should
 * strip wrongProduction from a London-market show reviewed by a UK or
 * dual-market outlet.
 *
 * Background (task #1189): this was the largest wrongProduction auto-clear
 * path (rebuild-all-reviews.js:2464-2534) but, unlike shouldAutoClearWrongProduction/
 * shouldAutoClearWrongShowUkUrl/shouldAutoClearWrongShow, it was never
 * extracted into a named, unit-testable predicate — leaving it invisible to
 * scoring-delta.js's mandated inclusion replay (CLAUDE.md rule 12.7).
 *
 * A UK-outlet URL (or a dual-market/london-registry-region outlet) on a
 * London-market show is a strong signal the wrongProduction flag is a
 * cross-market false positive — but only when nothing else outranks that
 * heuristic: a structural date/URL-year flag, a review that genuinely
 * predates the show, explicit CV confirmation, a manual reason, a show-
 * listing (not dated-review) URL, or a unanimous ensemble wrong_production
 * verdict / stale-relative-to-URL-rewrite text (task #1156/#1162 generalized
 * the ensemble-consensus guard — already used by shouldAutoClearWrongShowUkUrl
 * — to this wrongProduction path too; landed on main while this extraction
 * was in flight, reconciled here at merge time).
 *
 * Callers compute the URL/outlet/date classification (isUkUrl, outletIsDualOrUk,
 * outletIsLondonRegion, isDateMismatch, isShowListingUrl, cvBlocksClear) so this
 * module stays decoupled from venue-classification, review-normalization,
 * cross-production-guards, and review-guards.js (which itself requires this
 * module — see review-guards.js:598 — so importing back would be circular).
 *
 * @param {object} data - the review JSON object
 * @param {object} ctx
 * @param {boolean} ctx.isLondonMarketShow - isLondonMarket(showCat)
 * @param {boolean} ctx.isUkUrl - venue-classification's isUkOutletUrl(data.url)
 * @param {boolean} ctx.outletIsDualOrUk - outlet is in DUAL_MARKET_OUTLETS or registry region 'london'
 * @param {boolean} ctx.outletIsLondonRegion - registry region 'london' specifically (subset of outletIsDualOrUk)
 * @param {boolean} ctx.isDateMismatch - review predates the show's earliest date by more than PRE_WINDOW_DAYS
 * @param {boolean} ctx.isShowListingUrl - URL is a listing/aggregate page, not a dated review
 * @param {boolean} ctx.cvBlocksClear - cvBlocksUkWrongProductionAutoClear(data.contentVerification)
 * @returns {boolean}
 */
function shouldAutoClearWrongProductionUkDualMarket(data, ctx = {}) {
  if (!data || data.wrongProduction !== true) return false;
  if (data.wrongProductionOverride) return false;
  if (!ctx.isLondonMarketShow) return false;
  if (!data.url) return false;

  const wpNote = data.wrongProductionNote || '';
  const isStructuralFlag = wpNote.includes('Same URL exists') || wpNote.includes('Pre-opening guard')
    || wpNote.includes('days before show opened') || wpNote.includes('URL contains year');
  if (isStructuralFlag) return false;
  if (ctx.isDateMismatch) return false;

  // Outer gate: outlet must be UK-URL or dual/UK-market. Inner gate: UK URL
  // or specifically registry-region 'london' (dual-market outlets alone are
  // NOT enough here — their flags can be genuine same-title other-market
  // reviews, see the inline comment this predicate replaces).
  if (!ctx.isUkUrl && !ctx.outletIsDualOrUk) return false;
  if (!ctx.isUkUrl && !ctx.outletIsLondonRegion) return false;

  if (ctx.cvBlocksClear) return false;
  if (data.wrongProductionReason) return false;
  if (ctx.isShowListingUrl) return false;
  if (hasEnsembleConsensus(data, 'wrong_production')) return false;
  if (isTextStaleRelativeToUrlRewrite(data)) return false;

  return true;
}

module.exports = {
  hasEnsembleConsensus,
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  shouldAutoClearWrongProductionUrlYear,
  shouldAutoClearWrongShowUkUrl,
  isTextStaleRelativeToUrlRewrite,
  isWithinPriorRun,
  findMatchingPriorRun,
  hasDeclaredPriorRuns,
  isWithinTourLeg,
  hasDeclaredTourLegs,
  shouldAutoClearWrongProductionPriorRun,
  shouldAutoClearWrongProductionTourLeg,
  shouldAutoClearDatelessRevival,
  shouldAutoClearStaleDateGuard,
  shouldAutoClearWrongProductionUkDualMarket,
};
