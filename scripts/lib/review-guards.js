/**
 * Pure decision functions extracted from the opening night pipeline.
 *
 * These are exported so the test suite can require() and test the REAL logic.
 * The rule: never copy logic into a test file — always require() the real function.
 * If production code changes, the test must be updated. That's the point.
 *
 * See: scripts/test-opening-night-fixes.js
 */

/**
 * Fix #12 — assignedScore skip guard (collect-review-texts.js)
 *
 * Returns true if a review should be skipped during collection because it already has
 * a valid score and sufficient text. This prevents re-collection from destroying live
 * scored reviews by fetching garbage that triggers LLM rejection flags.
 *
 * @param {Object} data - Review data object (from review-texts JSON file)
 * @param {number} reviewFilterSize - Size of the explicit review filter (CONFIG.reviewFilter.size).
 *   When >0, the caller is targeting specific reviews — guard is bypassed.
 */
function shouldSkipScoredReview(data, reviewFilterSize = 0) {
  const textLen = data.fullText ? data.fullText.length : 0;
  return (
    data.assignedScore >= 1 &&
    data.assignedScore <= 100 &&
    textLen >= 100 &&
    reviewFilterSize === 0
  );
}

/**
 * Fix #13 — Revival slug preference (discover-dtli-slugs.js)
 *
 * Given a showId and array of candidate DTLI slug strings, picks the best one.
 * For revival shows (ID has year suffix like -2026), prefers the slug with the
 * highest numeric suffix (e.g. "giant-2" over "giant") — the suffix indicates
 * production order. This prevents old bare slugs from blocking the correct revival slug.
 *
 * @param {string} showId - Our show ID (e.g. "giant-2026", "hamilton")
 * @param {string[]} slugs - Candidate DTLI slug strings (e.g. ["giant", "giant-2"])
 * @returns {string} The best slug
 */
function pickBestDtliSlug(showId, slugs) {
  if (!slugs || slugs.length === 0) return null;
  let best = slugs[0];
  if (slugs.length > 1) {
    const showYearMatch = showId.match(/-(\d{4})$/);
    const showYear = showYearMatch ? parseInt(showYearMatch[1]) : null;
    if (showYear) {
      const withSuffix = slugs.filter(s => /-\d+$/.test(s));
      if (withSuffix.length > 0) {
        best = withSuffix.sort((a, b) => {
          const nA = parseInt((a.match(/-(\d+)$/) || [0, 0])[1]);
          const nB = parseInt((b.match(/-(\d+)$/) || [0, 0])[1]);
          return nB - nA;
        })[0];
      }
    }
  }
  return best;
}

/**
 * Fix #14 — Temporal override for wrongProduction/isFilmTv (content-verifier.js)
 *
 * Reviews published within 30 days of opening night are almost certainly reviewing
 * the current production. If an LLM flags wrongProduction or isFilmTv for a review
 * this close to opening, we downgrade wrongProduction confidence to 'low' and clear
 * isFilmTv entirely. Low confidence prevents fullText nulling.
 *
 * BYPASS (Schmigadoon 2026-04-21 EBT incident): when CV issues/reasoning contain
 * explicit "completely different show" markers, the override does NOT fire. This
 * is not an LLM false positive near opening — it's definitive evidence of wrong
 * content (e.g., a scraper fetched Every Brilliant Thing URL instead of Schmigadoon).
 * Those signals should override the opening-week safety net, not be overridden by it.
 *
 * @param {boolean} wpFlag - LLM's wrongProduction flag
 * @param {boolean} filmTvFlag - LLM's isFilmTv flag
 * @param {string} wpConfidence - LLM's confidence level ('high'|'medium'|'low')
 * @param {string|null} openingDate - Show's opening date (YYYY-MM-DD)
 * @param {string|null} publishDate - Review's publish date (YYYY-MM-DD)
 * @param {object} [cvContext] - Optional CV signals. {issues: string[], reasoning: string}
 * @returns {{ wpConfidence: string, filmTvFlag: boolean, bypassedForStrongSignal: boolean }}
 */
const STRONG_DIFFERENT_SHOW_MARKERS = [
  /does not appear in/i,
  /doesn'?t appear in/i,
  /not appear(?: in| at all)/i,
  /completely different show/i,
  /different production entirely/i,
  /wrong production entirely/i,
  /reviews the wrong production/i,
  /reviews? a different show/i,
  /unrelated to the expected/i,
  /not mentioned in/i,
  /expected show[^.]*(?:does not|doesn'?t|not)[^.]*appear/i,
  // Film-review leak class (Hamlet 2026-05-08 vulture--bilge-eberi):
  // when CV explicitly says "this is a film review of …" or "scraped content is a film review of …"
  // the override should NOT downgrade — these are unambiguous wrong-medium reviews, not LLM jitter
  // about a legit theater review near opening. Patterns require the explicit "is a film/movie review of"
  // construction, NOT just "film adaptation" mentions (which legit theater reviews compare to).
  /\b(?:this|the scraped content) is a (?:film|movie) review of\b/i,
  /\b(?:scraped content|this) is a review of (?:a|an|the) (?:film|movie) (?:adaptation|version)\b/i,
];

function hasStrongDifferentShowSignal(cvIssues, cvReasoning) {
  const texts = [];
  if (Array.isArray(cvIssues)) texts.push(...cvIssues.map(String));
  if (cvReasoning) texts.push(String(cvReasoning));
  if (texts.length === 0) return false;
  return texts.some(t => STRONG_DIFFERENT_SHOW_MARKERS.some(re => re.test(t)));
}

/**
 * Named-different-director bypass (Hamlet 2026-05-08 FRC class).
 *
 * Hamlet OB 2026 FRC review (Vahni Kurra) was actually for Teatro La Plaza's
 * Hamlet directed by Chela De Ferrari — a completely different production at a
 * different venue. CV flagged wrongProduction:true with reasoning explicitly
 * naming "Chela De Ferrari", but the temporal override fired (within 30d of
 * opening) and downgraded confidence to 'low', allowing the review through with
 * score 91.
 *
 * Bypass logic: if the CV reasoning/issues name a director via "directed by X"
 * AND that director's last name is NOT in the show's creativeTeam directors,
 * AND the show's actual director's last name is NOT mentioned ≥2 times in the
 * scraped fullText (which would indicate the review IS legit and just compares
 * to a film/historical production), keep the wrongProduction flag at full
 * confidence rather than downgrading.
 *
 * The fullText guardrail is critical: corpus probe (2026-05-08) showed that
 * 9 of 10 candidates flagged by name-mismatch alone were CV false positives
 * where the review was legit but mentioned a film director or historical
 * director in passing (e.g. dog-day-afternoon-2026 mentions Sidney Lumet 2x
 * but is actually a real Rupert Goold stage review). Requiring the show's
 * actual director NOT be mentioned ≥2x correctly keeps the override on those.
 *
 * Prerequisite: shows.json creativeTeam must have accurate Director entries.
 * Phase 0 audit shipped 14 director corrections on 2026-05-08 (commits
 * 93eaabcf, 30d81ad2, abfa15fd in broadway-scorecard-data) using critic-
 * mention consensus to identify and fix misattributions.
 */
const DIRECTED_BY_RE = /\bdirected by ([A-Z][a-zA-ZÀ-ÿ'-]+(?: [A-Z][a-zA-ZÀ-ÿ'-]+){1,3})/g;

function _normLastName(s) {
  const cleaned = String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).pop();
}

// Match stage director credits only — excludes Music Director, Casting Director,
// Associate Director, Movement Director, Musical Director, Sound Director, etc.
// shows.json (2026-05-09 audit): 2099 "Director" + 61 "Director & Choreographer"
// + 1 "Co-Director" + 1 "Book, Director" qualify; the rest do not. Without this
// filter, a CV-named stage director sharing a last name with the show's Music
// Director or Casting Director would silently match expected and kill the bypass.
const STAGE_DIRECTOR_ROLE_RE = /^(?:director(?:\s*&\s*choreographer)?|co-director|book,\s*director)$/i;

function _isStageDirectorRole(role) {
  return STAGE_DIRECTOR_ROLE_RE.test(String(role || '').trim());
}

function hasNamedDifferentDirectorSignal(cvIssues, cvReasoning, show, fullText) {
  if (!show || !fullText) return false;
  const directors = (show.creativeTeam || []).filter(c => _isStageDirectorRole(c.role));
  const expectedLastNames = new Set(directors.map(c => _normLastName(c.name)).filter(Boolean));
  if (expectedLastNames.size === 0) return false;

  const cvText = [
    ...(Array.isArray(cvIssues) ? cvIssues.map(String) : []),
    String(cvReasoning || ''),
  ].join(' | ');
  if (!cvText) return false;

  const cvNamedLastNames = new Set();
  for (const m of cvText.matchAll(DIRECTED_BY_RE)) {
    const ln = _normLastName(m[1]);
    if (ln) cvNamedLastNames.add(ln);
  }
  if (cvNamedLastNames.size === 0) return false;

  // Require: at least one CV-named director NOT in expected, AND no CV-named director matches expected
  const anyMatched = [...cvNamedLastNames].some(n => expectedLastNames.has(n));
  if (anyMatched) return false;

  // Guardrail: if the SHOW's actual director's last name appears ≥2 times in the
  // scraped fullText, the review is almost certainly legitimate and the CV-named
  // director is a passing reference (e.g. comparing to a film or historical revival).
  for (const expected of expectedLastNames) {
    if (expected.length < 4) continue; // skip 3-letter names (too noisy: "gold", "ash")
    const re = new RegExp('\\b' + expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    const mentions = (fullText.match(re) || []).length;
    if (mentions >= 2) return false;
  }

  return true;
}

function applyTemporalOverrides(wpFlag, filmTvFlag, wpConfidence, openingDate, publishDate, cvContext) {
  let resultWpConfidence = wpConfidence;
  let resultFilmTvFlag = filmTvFlag;

  const strongDifferent =
    !!(cvContext && hasStrongDifferentShowSignal(cvContext.issues, cvContext.reasoning)) ||
    !!(cvContext && hasNamedDifferentDirectorSignal(cvContext.issues, cvContext.reasoning, cvContext.show, cvContext.fullText));

  if (!strongDifferent && openingDate && publishDate) {
    const opening = new Date(openingDate);
    const publish = new Date(publishDate);
    if (!isNaN(opening.getTime()) && !isNaN(publish.getTime())) {
      const daysDiff = Math.abs((publish.getTime() - opening.getTime()) / 86400000);
      if (daysDiff <= 30) {
        if (wpFlag) resultWpConfidence = 'low';
        if (filmTvFlag) resultFilmTvFlag = false;
      }
    }
  }

  return {
    wpConfidence: resultWpConfidence,
    filmTvFlag: resultFilmTvFlag,
    bypassedForStrongSignal: strongDifferent,
  };
}

/**
 * Same-title / different-year false-positive guard (R&J Delacorte 2026 incident).
 *
 * Returns true when a review's publishDate falls inside THIS production's own
 * run window — from previewsStartDate (or openingDate) minus a lead grace,
 * through the later of openingDate/closingDate plus a lag grace.
 *
 * A review published inside its own production's window is overwhelmingly about
 * THAT production, even when a same-title production exists in another year.
 * On 2026-06-15 the LLM flagged in-window Shakespeare-in-the-Park reviews of
 * romeo-and-juliet-off-broadway-2026 (opening 2026-06-11) as the 2024
 * Connor/Zegler Broadway "Romeo + Juliet" because the titles collide — the
 * show went scoreless on the live site and the newsletter.
 *
 * Used as a hard exemption against same-title/different-year wrongProduction
 * flags in classify-wrong-production.js. NOT wired into applyTemporalOverrides
 * or the rebuild CV pre-pass, which protect genuine concurrent-different-
 * production flags (e.g. Hamlet 2026 FRC named-director bypass) via other paths.
 *
 * Pure — no I/O. leadDays defaults to 21 (critics attend previews ahead of
 * opening); lagDays defaults to 30 (a review can post weeks after opening),
 * matching the existing applyTemporalOverrides 30-day trailing window.
 *
 * @param {{ previewsStartDate?: string, openingDate?: string, closingDate?: string }} show
 * @param {string|null} publishDate
 * @param {{ leadDays?: number, lagDays?: number }} [opts]
 * @returns {boolean}
 */
function isReviewWithinOwnProductionWindow(show, publishDate, opts = {}) {
  if (!show || !publishDate) return false;
  const leadDays = Number.isFinite(opts.leadDays) ? opts.leadDays : 21;
  const lagDays = Number.isFinite(opts.lagDays) ? opts.lagDays : 30;
  const start = show.previewsStartDate || show.openingDate;
  const openOrStart = show.openingDate || show.previewsStartDate;
  if (!start || !openOrStart) return false;
  const startMs = new Date(start).getTime();
  let upperMs = new Date(openOrStart).getTime();
  const publishMs = new Date(publishDate).getTime();
  if (isNaN(startMs) || isNaN(upperMs) || isNaN(publishMs)) return false;
  // Upper bound = the later of opening / closing, plus the lag grace.
  if (show.closingDate) {
    const closeMs = new Date(show.closingDate).getTime();
    if (!isNaN(closeMs) && closeMs > upperMs) upperMs = closeMs;
  }
  const lowerBound = startMs - leadDays * 86400000;
  const upperBound = upperMs + lagDays * 86400000;
  return publishMs >= lowerBound && publishMs <= upperBound;
}

/**
 * Decide whether a wrongProduction verdict is a same-title/different-year false
 * positive: the review is in-window of THIS production AND the alleged target
 * production (if known) is NOT itself active at publish time. A concurrent
 * same-title production (two stagings in the same weeks) is NOT exempted — that
 * could genuinely be the review's subject, so real cross-attribution detection
 * is preserved.
 *
 * @param {object} show - the production the review is filed under
 * @param {string|null} publishDate
 * @param {object|null} [targetShow] - the production the classifier thinks the review belongs to
 * @returns {boolean}
 */
function isSameTitleDifferentYearFalsePositive(show, publishDate, targetShow = null) {
  if (!isReviewWithinOwnProductionWindow(show, publishDate)) return false;
  // If the alleged target production is itself running near publish time, the
  // flag could be a real concurrent cross-attribution — don't exempt.
  if (targetShow && isReviewWithinOwnProductionWindow(targetShow, publishDate, { leadDays: 21, lagDays: 60 })) {
    return false;
  }
  return true;
}

/**
 * Festival / public-theater venue carve-out (R&J Delacorte 2026 incident).
 *
 * The Public Theater's Delacorte Theater (Free Shakespeare in the Park) is a
 * legitimate NYC not-for-profit venue that this dataset files under the
 * `off-broadway` category. The contentVerification LLM repeatedly objects that
 * "Delacorte / Shakespeare in the Park is NOT an Off-Broadway venue" and turns
 * that venue-taxonomy quibble into BOTH a wrongProduction flag and isValid=false
 * — dropping legitimate, correctly-attributed reviews. On 2026-06-15 this made
 * romeo-and-juliet-off-broadway-2026 render scoreless.
 *
 * Venue classification is never grounds for wrongProduction (the review is about
 * the right show at the right venue) and is not, by itself, grounds for
 * isValid=false. Scoped to shows whose OWN venue is one of the exempt festival
 * venues, so a genuine wrong-venue / tour review on an ordinary show is
 * unaffected.
 */
// Scoped to the OUTDOOR festival stage only (Delacorte / Free Shakespeare in the
// Park). Deliberately does NOT match the broader "Public Theater" family — the
// Public's indoor Newman / Anspacher / LuEsther / Joe's Pub stages are
// unambiguously off-broadway and carry no "is this Off-Broadway?" taxonomy
// quibble, so the carve-out must not widen to them (ship-check P0, 2026-06-16).
const FESTIVAL_VENUE_SHOW_RE = /delacorte|shakespeare in the park/i;

// An issue / reasoning fragment is a "venue-classification objection" when it
// argues the venue isn't Off-Broadway / is an outdoor festival stage, rather
// than identifying wrong content. Anchored to festival-venue vocabulary so
// truncation / byline / excerpt-mismatch issues are NOT swept up.
const VENUE_CLASSIFICATION_OBJECTION_RE = /(?:not\b[^.]*\boff-?broadway|off-?broadway[^.]*\bnot\b|shakespeare in the park|delacorte|outdoor (?:summer )?festival|central park)/i;

// A fragment that asserts a genuinely DIFFERENT production (not a venue-taxonomy
// quibble): a comparative production reference, an explicit wrong-show/wrong-
// production phrase, or the SHOW (not an excerpt) being absent from the text.
// A year-mismatch check is layered on in reasoningAssertsDifferentProduction().
// Used to veto the venue carve-out so a real different-year/different-cast review
// at the SAME festival stage (e.g. "the 2023 Delacorte staging, not the 2026
// one") is NOT cleared.
//
// Deliberately precise — does NOT reuse hasStrongDifferentShowSignal here because
// its broad `/does not appear in/i` marker collides with the legitimate
// excerpt-mismatch phrasing ("the known excerpt does not appear in the scraped
// text") that the real R&J/NYSR venue-objection CV carries. The show-absence
// alternative below is subject-anchored to show/production/play/musical/title so
// "the excerpt does not appear" does NOT trip it.
const DIFFERENT_PRODUCTION_ASSERTION_RE = new RegExp([
  '\\b(?:different|another|separate|earlier|prior|previous|original|other)\\s+(?:cast|director|production|staging|show|mounting|revival|version|season|run|engagement|company)\\b',
  '\\breviews?\\s+(?:a|an|the)?\\s*different\\s+show\\b',
  '\\bwrong\\s+production\\b',
  '\\b(?:completely|entirely)\\s+different\\s+(?:show|production)\\b',
  '\\bdifferent\\s+(?:show|production)\\s+entirely\\b',
  '\\b(?:expected\\s+show|the\\s+show|the\\s+production|the\\s+play|the\\s+musical|the\\s+title)\\b[^.]*\\bdoes(?:n.?t| not)\\s+appear\\b',
].join('|'), 'i');

function isVenueClassificationObjection(text) {
  if (!text) return false;
  return VENUE_CLASSIFICATION_OBJECTION_RE.test(String(text));
}

function showHasFestivalVenue(show) {
  return !!(show && show.venue && FESTIVAL_VENUE_SHOW_RE.test(show.venue));
}

function reasoningAssertsDifferentProduction(text, show) {
  const t = String(text || '');
  if (DIFFERENT_PRODUCTION_ASSERTION_RE.test(t)) return true;
  // Any 20xx year that differs from this show's own year → different-year staging.
  const showYear = String((show && (show.openingDate || show.previewsStartDate)) || '').slice(0, 4);
  if (/^\d{4}$/.test(showYear)) {
    const years = t.match(/\b20\d{2}\b/g) || [];
    if (years.some(y => y !== showYear)) return true;
  }
  return false;
}

/**
 * Apply the festival-venue carve-out to a parsed contentVerification result.
 * Pure — returns a NEW object plus flags; never mutates input.
 *
 *   - wrongProduction is cleared when the LLM's primary reasoning is a venue
 *     objection AND there is no strong "different show" signal.
 *   - isValid=false is restored to true ONLY when the venue objection is the
 *     SOLE issue (no truncation / byline / garbage issue remaining) — so a
 *     genuinely truncated Delacorte review stays isValid=false.
 *
 * @param {{ wrongProduction?: boolean, isValid?: boolean, issues?: string[], reasoning?: string }} cv
 * @param {{ venue?: string }} show
 * @returns {{ wrongProduction: boolean, isValid: boolean, issues: string[], reasoning: string,
 *   venueCarveoutApplied: boolean, clearedWrongProduction: boolean, restoredValidity: boolean }}
 */
function applyVenueClassificationCarveout(cv, show) {
  const issues = Array.isArray(cv && cv.issues) ? cv.issues.slice() : [];
  const reasoning = (cv && cv.reasoning) || '';
  const out = {
    wrongProduction: !!(cv && cv.wrongProduction),
    isValid: cv && cv.isValid !== undefined ? cv.isValid : true,
    issues,
    reasoning,
    venueCarveoutApplied: false,
    clearedWrongProduction: false,
    restoredValidity: false,
  };
  if (!showHasFestivalVenue(show)) return out;

  const venueIssues = issues.filter(isVenueClassificationObjection);
  const otherIssues = issues.filter(i => !isVenueClassificationObjection(i));
  const reasoningIsVenue = isVenueClassificationObjection(reasoning);

  // wrongProduction driven by the venue objection → clear, UNLESS a
  // different-production assertion (comparative cast/director/staging, an
  // explicit wrong-show/wrong-production phrase, the SHOW being absent, or a
  // year ≠ this show's) appears anywhere in the reasoning OR issues. This
  // catches "the 2023 Delacorte staging, not the 2026 one" and "Reviews a
  // different show" without colliding with the excerpt-mismatch phrasing the
  // legit R&J/NYSR venue objection carries. (ship-check P0, 2026-06-16.)
  const venueClearText = [reasoning, ...issues].join(' | ');
  if (out.wrongProduction
      && reasoningIsVenue
      && !reasoningAssertsDifferentProduction(venueClearText, show)) {
    out.wrongProduction = false;
    out.clearedWrongProduction = true;
    out.venueCarveoutApplied = true;
  }

  // isValid=false driven ONLY by the venue objection → restore validity.
  if (out.isValid === false && venueIssues.length > 0 && otherIssues.length === 0) {
    out.isValid = true;
    out.restoredValidity = true;
    out.venueCarveoutApplied = true;
  }

  return out;
}

/**
 * URL-path date fallback for wrongProduction detection.
 *
 * When a review lacks publishDate (common on SERP ingests with Unknown bylines),
 * extract the publish date from the URL path. Supports two patterns:
 *   - NYT / Variety / Playbill / Vulture / WaPo: /YYYY/MM/DD/ or /YYYY/MM/
 *   - Guardian: /YYYY/monthname/DD/  (e.g. /2025/jun/30/)
 *
 * Applies a 30-day-before-earliest lead window for Broadway and a wider 180-day
 * window for off-broadway (which legitimately carries same-season pre-transfer /
 * out-of-town coverage). Also checks the post-closing window so revival/tour
 * articles about closed productions are flagged. Reviews dated within a declared
 * show.priorRuns window are exempt in ALL markets (legit earlier-staging coverage).
 *
 * Off-broadway was BLANKET-exempt here until 2026-06-05 — meaning no URL-date
 * guard ran for OB shows at all, which let a 2025 "Our New Girl" Guardian article
 * cross-attribute to the 2026 "Girl, Interrupted" OB show via the "girl" title
 * token. The narrower fix (wide OB window + priorRuns exemption) catches that
 * 13-month gap without flagging real same-season pre-transfer reviews.
 *
 * Returns a reason string (to be used as wrongProductionNote) or null if:
 *   - url / show missing
 *   - url path has no /YYYY/MM[/DD]/ or /YYYY/monthname[/DD]/ segment
 *   - show has no earliest date to compare against
 *   - extracted URL date is within a declared prior-run window
 *   - extracted URL date is within both the lead window and the trailing window
 *
 * @param {string|null} url
 * @param {{ previewsStartDate?: string, openingDate?: string, closingDate?: string, category?: string }} show
 * @returns {string|null}
 */
const URL_MONTH_NAMES = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Extract a 4-digit year from a URL path segment matching the standard
 * `/YYYY/MM/` or `/YYYY/monthname/` review-URL conventions used by NYT,
 * Variety, Playbill, Vulture, WaPo, and the Guardian. Returns the year as a
 * number, or null when no such segment is present.
 *
 * Pure helper — shares the same regex as getWrongProductionReasonFromUrl
 * below so behavior stays in lock-step. Intended for reuse by sibling-show
 * disambiguation classifiers that only need the year, not the full window
 * comparison.
 *
 * @param {string|null|undefined} url
 * @returns {number|null}
 */
function urlYearFromPath(url) {
  if (!url || typeof url !== 'string') return null;
  // Numeric month: /YYYY/MM/ or /YYYY/MM/DD/
  // Word month: /YYYY/monthname/ or /YYYY/monthname/DD/ (Guardian pattern)
  const m = url.match(/\/(20\d{2})\/([a-z]{3,4}|\d{2})(?:\/(\d{1,2}))?\//i);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  return Number.isFinite(year) ? year : null;
}

function getWrongProductionReasonFromUrl(url, show) {
  if (!url || typeof url !== 'string') return null;
  if (!show) return null;
  const earliest = show.previewsStartDate || show.openingDate;
  if (!earliest) return null;

  // Numeric month: /YYYY/MM/ or /YYYY/MM/DD/
  // Word month: /YYYY/monthname/ or /YYYY/monthname/DD/ (Guardian pattern)
  const m = url.match(/\/(20\d{2})\/([a-z]{3,4}|\d{2})(?:\/(\d{1,2}))?\//i);
  if (!m) return null;

  const year = m[1];
  const rawMonth = m[2].toLowerCase();
  const month = /^\d{2}$/.test(rawMonth) ? rawMonth : URL_MONTH_NAMES[rawMonth];
  if (!month) return null;

  const dayPart = m[3] ? String(m[3]).padStart(2, '0') : '15';
  const urlDate = new Date(`${year}-${month}-${dayPart}`);
  if (isNaN(urlDate.getTime())) return null;

  // Prior-run exemption (ALL markets): a review dated within a declared prior
  // run is legitimate coverage of an earlier staging, not a wrong-production
  // cross-attribution. Off-broadway shows in particular carry same-season
  // out-of-town / earlier-venue coverage — without this exemption the wider OB
  // window below would false-flag it (e.g. Sexual Misconduct of the Middle
  // Classes 2026, whose Audible Minetta Lane 2025 reviews predate previews by
  // ~290 days). Lazy require to avoid a load-order cycle.
  const { isWithinPriorRun } = require('./wrong-production-autoclear');
  if (isWithinPriorRun(urlDate, show.priorRuns)) return null;

  const earliestDate = new Date(earliest);
  if (isNaN(earliestDate.getTime())) return null;

  const daysBefore = Math.round((earliestDate - urlDate) / 86400000);
  const urlDateStr = urlDate.toISOString().slice(0, 10);

  // Post-closing check first: an article dated after close is a later production/tour,
  // independent of whether it's also before the previews of this production's ID.
  if (show.closingDate) {
    const closing = new Date(show.closingDate);
    if (!isNaN(closing.getTime())) {
      const daysAfter = Math.round((urlDate - closing) / 86400000);
      if (daysAfter > 30) {
        return `Auto-flagged: URL date ${urlDateStr} is ${daysAfter} days after show closed (${show.closingDate}). Likely later production/revival/tour.`;
      }
    }
  }

  // Lead window: off-broadway legitimately carries same-season pre-transfer
  // coverage, so use a wider window (180d) than Broadway (30d). Anything beyond
  // that — and not within a declared prior run (exempted above) — is a
  // cross-attribution, not pre-transfer coverage. This is the guard that catches
  // a 2025 "Our New Girl" Guardian article landing on the 2026 "Girl, Interrupted"
  // OB show via the shared "girl" title token (girl-interrupted incident,
  // 2026-06-05). Pre-2026-06-05, off-broadway was blanket-exempt here, so no
  // date guard ran for OB at all.
  const leadWindowDays = show.category === 'off-broadway' ? 180 : 30;
  if (daysBefore > leadWindowDays) {
    return `Auto-flagged: URL date ${urlDateStr} is ${daysBefore} days before show earliest date ${earliest}. Likely prior/different production.`;
  }

  return null;
}

/**
 * Wrapper around getWrongProductionReasonFromUrl that only fires when the review
 * has NO named critic (Unknown / Staff / empty). Used at ingest time in
 * gather-reviews.js to catch Unknown-byline SERP pollution without false-positive
 * risk on named-critic pre-transfer coverage (e.g. Jesse Green reviewing a
 * Public Theater OB run before Broadway transfer).
 *
 * The base URL-date rule alone can't distinguish "different production" from
 * "same production, pre-transfer venue" — named critics deserve the benefit of
 * the doubt there. Unknown-byline SERP hits do not (that's the exact class of
 * hit that caused the Fallen Angels 2026 opening-night cleanup).
 *
 * The raw helper (getWrongProductionReasonFromUrl) is still available for
 * opt-in post-hoc audits where a human reviews each flag.
 *
 * @param {{ url?: string|null, criticName?: string|null }} review
 * @param {{ previewsStartDate?: string, openingDate?: string, closingDate?: string, category?: string }} show
 * @returns {string|null}
 */
function getWrongProductionReasonForUnknownCritic(review, show) {
  if (!review) return null;
  const norm = String(review.criticName || '').trim().toLowerCase();
  const criticIsUnknown = !norm || norm === 'unknown' || norm === 'staff';
  if (!criticIsUnknown) return null;
  return getWrongProductionReasonFromUrl(review.url, show);
}

/**
 * Check if a URL looks like a review for the given show title.
 * Filters out tag pages, author pages, ticket links, etc.
 * Used in site-search-discovery.js to filter URLs returned by section-page scrapers.
 *
 * Title matching: strips non-alphanumeric chars, removes articles + short words (≤2 chars),
 * requires ≥50% of remaining title words to appear in the URL. Fails open (returns true)
 * when no significant title words remain — better to include than miss.
 *
 * @param {string} url - The URL to check
 * @param {string} showTitle - The show title to match against
 * @returns {boolean}
 */
function urlTitleWordsPass(lowerUrl, showTitle) {
  // NFD-normalize + strip diacritics BEFORE the [^a-z0-9\s] filter.
  // Otherwise "Último" tokenizes to ["ltimo"] (the char filter removed the
  // accented Ú leaving a meaningless fragment) and downstream slug matching
  // fails silently. Same bug class as operaTitleWords in site-search-discovery.js
  // (fixed 2026-05-17); applies to every non-opera SERP/site-search caller.
  const titleWords = showTitle
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));

  // Zero meaningful words: fail-open (original behavior — better to include than miss).
  if (titleWords.length === 0) return true;

  const isTBWorldPath = /talkinbroadway\.com\/(?:page\/)?world\//i.test(lowerUrl);
  if (isTBWorldPath) {
    const matchCountTB = titleWords.filter(w => lowerUrl.includes(w)).length;
    const minMatchTB = titleWords.length <= 3 ? titleWords.length : Math.ceil(titleWords.length * 0.5);
    return matchCountTB >= minMatchTB;
  }

  const wordMatch = (haystack, word) => {
    const escaped = word.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[\\s\\-/.\'"_])' + escaped + '(?:$|[\\s\\-/.\'"_\\d])', 'i').test(haystack);
  };
  const matchCount = titleWords.filter(w => wordMatch(lowerUrl, w)).length;
  const minMatch = titleWords.length <= 3 ? titleWords.length : Math.ceil(titleWords.length * 0.5);
  return matchCount >= minMatch;
}

function urlLooksLikeReview(url, showTitle) {
  const lower = url.toLowerCase();
  // Reject non-article URLs
  if (lower.includes('/tag/') || lower.includes('/author/') || lower.includes('/category/')) return false;
  if (lower.includes('/search') || lower.includes('/obituar')) return false;
  // Reject /page/ pagination URLs but exempt Talkin' Broadway whose review URLs use /page/world/
  if (lower.includes('/page/') && !lower.includes('talkinbroadway.com/page/')) return false;
  if (lower.includes('ticket') && !lower.includes('review')) return false;

  if (urlTitleWordsPass(lower, showTitle)) return true;

  // Short-title fallback for comma-subtitled shows ("Beaches, A New Musical" → "Beaches").
  // Outlet URL slugs typically carry only the short title ("/beaches-review-broadway.html").
  // Beaches 2026-04-22: rejected all outlet URLs (NYT/Guardian/People/EW/TimeOut/TheWrap/NYDN/NYT/…)
  // via outlet-domain-supplement urlTitleCheck before this fallback.
  //
  // Guard: short title must contain ≥1 meaningful word (length > 2, non-stopword).
  // Without this, "Oh, Mary!" → short "Oh" → zero meaningful words → urlTitleWordsPass
  // fail-opens (titleWords.length === 0 branch) and accepts ANY URL as valid. Affected
  // oh-mary-2024 + oh-mary-west-end-2025 (both open when ship-check caught the bug).
  const { shortTitleCandidate } = require('./title-normalization');
  const shortTitle = shortTitleCandidate(showTitle);
  if (shortTitle) {
    const shortMeaningfulWords = shortTitle
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));
    if (shortMeaningfulWords.length > 0 && urlTitleWordsPass(lower, shortTitle)) return true;
  }

  return false;
}

/**
 * Outlets whose article URLs carry NO human-readable slug — the path is an opaque
 * UUID/id, so urlLooksLikeReview() can never match show-title words and will reject
 * every legitimate review. The Financial Times is the canonical case: review URLs
 * are https://www.ft.com/content/{uuid} with no title in the path. Other paywalled
 * nationals (Times/Telegraph/Guardian/Independent) use slugged URLs and must NOT be
 * listed here — they pass the slug guard normally.
 *
 * Matched precisely by domain + path prefix so only article URLs (/content/...) get
 * the exemption; FT section/tag pages (/life-arts, /companies) are NOT matched.
 *
 * Callers that exempt these from the URL-slug guard MUST substitute a compensating
 * control — at minimum a SERP-result TITLE match (the show title appearing in the
 * Google result title). The domain-restricted + date-bounded SERP query (site:ft.com
 * "title" review {year}), a content-type title filter (reject interviews/obituaries),
 * and validateSerpCandidate's snippet check provide defense in depth.
 */
const SLUGLESS_REVIEW_URL_PATTERNS = [
  { domain: 'ft.com', pathPrefix: '/content/' },
];

/**
 * @param {string} url
 * @returns {boolean} true if the URL is a slugless article URL (e.g. FT /content/{uuid})
 *   that urlLooksLikeReview() cannot validate by slug.
 */
function isSluglessReviewUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const path = parsed.pathname.toLowerCase();
  return SLUGLESS_REVIEW_URL_PATTERNS.some(
    p => (host === p.domain || host.endsWith('.' + p.domain)) && path.startsWith(p.pathPrefix)
  );
}

/**
 * Date-mismatch guard: detects reviews likely from a prior production.
 *
 * If a review was published more than `thresholdDays` before the show's
 * earliest known date (opening night or first preview), it's almost
 * certainly reviewing a different production.
 *
 * Handles ordinal suffixes in date strings (e.g., "May 10th, 2019").
 *
 * @param {string|null} reviewDateStr - Review publish date string
 * @param {string|null} showEarliestDateStr - Show's earliest date (YYYY-MM-DD)
 * @param {number} thresholdDays - Days before show date to flag (default 90)
 * @returns {boolean} true if review is likely from a wrong production
 */
function isLikelyWrongProduction(reviewDateStr, showEarliestDateStr, thresholdDays = 90) {
  if (!reviewDateStr || !showEarliestDateStr) return false;
  const { parseDate } = require('./date-utils');
  const reviewDate = parseDate(reviewDateStr);
  const showDate = new Date(showEarliestDateStr);
  if (!reviewDate || isNaN(showDate.getTime())) return false;
  return (showDate - reviewDate) > thresholdDays * 86400000;
}

/**
 * Detect regional BWW URLs and local paper tour reviews that should not be
 * attributed to the production.
 *
 * For Broadway shows: blocks US regional BWW and local paper tour reviews.
 * For WE/OB shows: blocks US regional BWW (cross-market contamination) but
 * allows BWW westend/london (legitimate WE coverage).
 *
 * @param {string} url - Review URL
 * @param {string} showId - Show ID
 * @returns {boolean} true if the URL indicates a tour/regional review
 */
function isLikelyTourReview(url, showId) {
  if (!url || !showId) return false;

  const lower = url.toLowerCase();
  const isWestEnd = /-west-end/.test(showId) || /-off-west-end/.test(showId);
  const isOffBroadway = /-off-broadway/.test(showId);

  // Regional BWW (city-specific subdirectories)
  const bwwMatch = lower.match(/broadwayworld\.com\/([a-z-]+)\/article\//);
  if (bwwMatch) {
    const city = bwwMatch[1];
    // These are NOT regional — they're main BWW sections
    const nonRegional = ['article', 'off-broadway', 'reviews', 'board', 'columns', 'people', 'video', 'shows'];
    if (nonRegional.includes(city)) { /* not regional, fall through */ }
    else if (isWestEnd || isOffBroadway) {
      // For WE/OB shows: BWW westend and london are legitimate, US cities are not
      const ukCities = ['westend', 'london', 'uk-regional'];
      if (!ukCities.includes(city)) return true;
    } else {
      // For Broadway shows: all regional BWW is suspect
      return true;
    }
  }

  // Local paper tour indicators (Broadway shows only)
  if (!isWestEnd && !isOffBroadway) {
    const tourPatterns = [
      /star-telegram\.com.*fort-worth/i,
      /houstonchronicle\.com/i,
      /seattletimes\.com.*theater.*review/i,
      /dallasvoice\.com/i,
      /wehotimes\.com/i,
      /bocamag\.com/i,
      /cleveland\.com.*entertainment/i,
      /dailycardinal\.com/i,
      /latinlifedenver\.com/i,
      /charlotteledger\.substack\.com/i,
      /orlandoweekly\.com.*broadway-in-orlando/i,
      /mdtheatreguide\.com.*(national-tour|kennedy-center|hippodrome)/i,
      /dailygazette\.com.*nippertown.*proctors/i,
      /berkshireedge\.com.*proctors/i,
      /lansingcitypulse\.com/i,
    ];
    return tourPatterns.some(pattern => pattern.test(url));
  }

  return false;
}

/**
 * Detect roundup/aggregator URLs that shouldn't be treated as individual reviews.
 * Returns { isRoundup: true, reason: string } or { isRoundup: false }.
 */
function isRoundupUrl(url) {
  if (!url) return { isRoundup: false };

  // The Stage review-round-ups section
  if (/thestage\.co\.uk\/review-round-ups\//i.test(url)) {
    return { isRoundup: true, reason: 'The Stage review-round-ups page' };
  }

  // WestEndTheatre.com reviews pages (aggregator roundups, not individual reviews)
  if (/westendtheatre\.com\/.*\/reviews\//i.test(url)) {
    return { isRoundup: true, reason: 'WestEndTheatre.com aggregator roundup page' };
  }

  // LBO review roundups (aggregate other critics, not original reviews)
  // Match both `review-roundup` (1 hyphen) and `Review-Round-Up` (2 hyphens, the actual
  // pattern LBO uses, e.g. /news/post/Review-Round-Up%3A-PARANORMAL-ACTIVITY-...).
  // Stuart King email 2026-04-27 surfaced 17 LBO roundups that were being scored
  // because the 2-hyphen variant slipped through.
  if (/londonboxoffice\.co\.uk\/.*review-round[-_ ]?up/i.test(url)) {
    return { isRoundup: true, reason: 'LBO review roundup page' };
  }

  // Playbill "what do the critics think of" articles — multi-outlet roundups
  if (/playbill\.com\/article\/reviews?-what-do-the-critics-think-of/i.test(url)) {
    return { isRoundup: true, reason: 'Playbill critics-think-of roundup' };
  }

  // WhatsOnStage review round-ups — /news/{slug}-review-round-up_{id}/. One
  // 902-word roundup quoting 7 critics exploded into 7 per-critic files scored
  // 100 via unicode-stars on jesus-christ-superstar-west-end-2026 (2026-07-08).
  if (/whatsonstage\.com\/news\/[^/?#]*review-round-up/i.test(url)) {
    return { isRoundup: true, reason: 'WhatsOnStage review round-up page' };
  }

  // BroadwayWorld's /reviews/{show-slug} critics-aggregation page — a quote
  // mosaic of OTHER outlets' reviews plus a critics-average score widget, not
  // an individual review. Distinct from /article/... which is BWW's own
  // reviews. Ingested as a 13th T1 review on the-whoopi-monologues-off-
  // broadway-2026 (2026-07-14): took its score from the average widget and
  // its criticName from a quoted outlet's JSON-LD Person markup.
  if (/broadwayworld\.com\/reviews\/[^/?#]+\/?(?:[?#]|$)/i.test(url)) {
    return { isRoundup: true, reason: 'BroadwayWorld /reviews/ critics-aggregation page' };
  }

  // BroadwayWorld "Review Roundup: ..." articles — /article/Review-Roundup-{slug}
  // (optionally under a regional prefix like /westend/). These are BWW-staff-
  // bylined quote compilations of OTHER outlets' reviews, not BWW's own review
  // (those are /article/Review-{SHOW}- or /article/BWW-Review-, which this
  // pattern must NOT match). One was scored 75 and shipped as a second
  // first-party BWW review on the-oresteia-west-end-2026 (2026-07-19); a
  // corpus scan found 71 files with this primary-URL shape, every one already
  // flagged excluded — zero legitimate reviews live at these URLs.
  if (/broadwayworld\.com\/(?:[a-z0-9-]+\/)?article\/review-roundup-/i.test(url)) {
    return { isRoundup: true, reason: 'BroadwayWorld Review-Roundup article (multi-outlet quote compilation)' };
  }

  // NOTE: Do NOT add generic cross-domain roundup URL patterns (e.g. bare
  // /review-roundup/ on any host). Many legitimate individual critic reviews
  // are SOURCED from roundup pages — the URL points to the roundup where the
  // review was discovered, but the review itself has specific critic/outlet
  // attribution and should count as an original review.
  // Only flag site-specific patterns where the roundup PAGE is being treated as a review.

  return { isRoundup: false };
}

/**
 * Detect a stale isRoundupArticle flag on a file that actually contains an
 * individual critic's full review.
 *
 * Background (Notion 34e637c5-416f-817b): The isRoundupArticle flag has had
 * multiple over-eager setters over time:
 *   - Removed: `isRoundupUrl` once matched generic /review-roundup/ patterns,
 *     auto-flagging any review SOURCED from a roundup page (cleared 2026-04-01
 *     in d7bf1603b8 but the flag persisted on disk).
 *   - Still active: gather-reviews tags every file from KNOWN_ROUNDUP_OUTLETS
 *     (interested-bystander, the-clyde-fitch-report) even when the URL is an
 *     individual review post on the outlet's own domain.
 *   - Cross-show contamination poisoned excerpt fields, which (in older
 *     heuristics) read as roundup summaries.
 *
 * The flag blocks LLM scoring (is-scoreable / review-text-scoreable / rebuild),
 * silently dropping legitimate reviews. This predicate is whitelist-based: it
 * returns true only when the URL matches a per-outlet "individual review" URL
 * pattern that we know is one show per page. A blacklist (anything not on
 * isRoundupUrl) is too loose — Playbill, NYT, and others have multi-show
 * roundup URLs that don't match isRoundupUrl, and clearing those would let
 * roundup-as-review files leak into scoring.
 */
const INDIVIDUAL_REVIEW_URL_PATTERNS = [
  // The Clyde Fitch Report — `/YYYY/MM/{slug}/` per individual review
  /^https?:\/\/(?:www\.)?clydefitchreport\.com\/\d{4}\/\d{2}\/[^/]+\/?(?:[?#]|$)/i,
  // The Interested Bystander — Blogger `/YYYY/MM/{slug}.html` per individual review
  /^https?:\/\/(?:www\.)?interestedbystander\.com\/\d{4}\/\d{2}\/[^/]+\.html(?:[?#]|$)/i,
  // London Box Office — `/news/post/{slug}` is per-show; multi-show roundups use either
  // `review-roundup` (1 hyphen) or `Review-Round-Up` (2 hyphens) — exclude both.
  // (Caught by isRoundupUrl above; this lookahead is the secondary gate.)
  /^https?:\/\/(?:www\.)?londonboxoffice\.co\.uk\/news\/post\/(?!.*review-round[-_ ]?up)[^/]+\/?(?:[?#]|$)/i,
];

function isLikelyStaleRoundupFlag(data) {
  if (!data || data.isRoundupArticle !== true) return false;
  const fullText = (data.fullText || '').trim();
  if (fullText.length < 800) return false;
  if (data.isFullReview !== true) return false;
  const url = data.url || '';
  if (!url) return false;
  if (isRoundupUrl(url).isRoundup) return false;
  if (/\/article\/Review-Roundup-/i.test(url)) return false;
  return INDIVIDUAL_REVIEW_URL_PATTERNS.some(re => re.test(url));
}

/**
 * Returns true when wrongShow=true should be treated as already cleared by
 * a human override or wrongProduction-equivalent decision. Single source of
 * truth for the 5 manual-clear flags so all 4 gate sites
 * (isIncludableForRebuild, isScoreable, passesFlagFilters, llm-scoring/is-scoreable.ts)
 * stay in sync.
 *
 * Background: pre-2026-04-26, only isIncludableForRebuild honored these flags;
 * isScoreable and passesFlagFilters did not. A human-cleared wrongShow file
 * could pass rebuild but still be skipped by the LLM rescore — leaving the
 * file with no current score and no path back into reviews.json. Discovered
 * during the wrongShow stale-flag audit (Notion 34e637c5-416f-8121).
 */
function wrongShowCleared(data) {
  if (!data) return false;
  // Note: isCombinedReview alone is NOT sufficient. It's set whenever a URL
  // appears in 2+ show dirs, which can happen for roundups / year-end pieces
  // where a wrong_show flag is legitimate (article only nominally covers
  // this show). The script flag-combined-reviews.js's recovery branch sets
  // BOTH isCombinedReview:true AND wrongShowOverride:true after verifying
  // the URL co-occurrence pattern matches a true joint review (≥2 different
  // base shows + rejectionReason='wrong_show'). Requiring wrongShowOverride
  // ensures inclusion is gated on that explicit verification, not on
  // URL-shape alone. Issue #316 ship-check (P0/C+F): without this gate, a
  // future contentTier='invalid' upgrade on one of the 12 historical
  // isCombinedReview+wrongShow files could silently drop a feature/preview
  // into reviews.json.
  return (
    data.wrongShowManualClear === true ||
    data.wrongShowOverride === true ||
    data.wrongProductionManualClear === true ||
    data.wrongProductionOverride === true ||
    data.humanReviewedWrongProduction === false
  );
}

const WRONG_SHOW_TITLE_STOPWORDS = new Set([
  'the','a','an','of','and','or','for','to','in','on','at','with','as','by',
  'is','are','was','were','be','been','it','this','that','these','those',
  'review','musical','play','show','broadway','revival','off',
]);

function _wrongShowTitleTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !WRONG_SHOW_TITLE_STOPWORDS.has(t));
}

/**
 * Detect a stale wrongShow=true flag on a file that actually contains a
 * substantial individual critic review of THIS show.
 *
 * Background (Notion 34e637c5-416f-8121): wrongShow is set by 3 paths —
 *   (1) LLM ensemble rejection (rejectionReason='wrong_show'),
 *   (2) content-fingerprint cross-attribution audit (audit-cross-attribution.js),
 *   (3) manual flagging in ingest-manual-review.js.
 * Some are correct; others are stale post-fix. The Giant 2026-04-22 incident
 * (LLM mis-rejected real Broadway reviews because it knew "Giant the musical"
 * from training and called the play wrong-show) is the canonical false positive.
 *
 * Unlike isLikelyStaleRoundupFlag this predicate REQUIRES show context (title +
 * openingDate/id) — wrongShow is inherently about whether a file matches a
 * specific show. Without `show`, the predicate returns false (safe default).
 *
 * Tuned to be conservative — measured precision ~75% on a 20-file sample;
 * remaining ~25% FPs are caught by other gates (rejectedAt, contentVerification).
 * The companion sweep script (scripts/clear-stale-wrong-show-flags.js) layers
 * an LLM second-opinion before physically clearing the flag on disk.
 *
 * @param {object} data - Review-text JSON
 * @param {object} [show] - Show entry from shows.json (needs title; uses
 *   openingDate + id for year alignment when present)
 */
function isLikelyStaleWrongShow(data, show) {
  if (!data || data.wrongShow !== true) return false;
  if (!show || !show.title || String(show.title).length < 5) return false;

  const fullText = String(data.fullText || '').trim();
  if (fullText.length < 1500) return false;

  // Honor specific rejection reasons set by other guards. Only override
  // wrong_show ensemble rejections (Giant case); leave wrong_production,
  // garbage_text, not_a_review, etc. alone — those are different signals.
  if (data.rejectionReason && data.rejectionReason !== 'wrong_show') return false;

  // Don't override high-confidence content-verification mismatches — they're
  // a separate, stronger signal from the cross-attribution audit.
  if (
    data.contentVerification &&
    data.contentVerification.wrongArticle === true &&
    data.contentVerification.confidence === 'high'
  ) return false;

  if (data.fullTextWrongAuthor === true) return false;

  const url = data.url || data.sourceUrl || '';
  if (!url) return false;
  const u = url.toLowerCase();

  // Roundup / multi-show / feature article URLs — never individual reviews.
  if (isRoundupUrl(url).isRoundup) return false;
  if (/\/article\/review-roundup-/i.test(u)) return false;
  if (/\/article\/reviews-sound-off-/i.test(u)) return false;
  if (/\/article\/reviews-/i.test(u)) return false;
  if (/playbill\.com\/article\/reviews-/i.test(u)) return false;
  if (/westendtheatre\.com\/.*\/reviews-of-/i.test(u)) return false;
  if (/londonboxoffice\.co\.uk\/.*\/.*review-roundup/i.test(u)) return false;
  if (/thestage\.co\.uk\/review-round-ups/i.test(u)) return false;
  if (/\/review-roundup\//i.test(u)) return false;
  if (/\/reviews?-roundup\b/i.test(u)) return false;
  if (/broadway-shockers-\d{4}/i.test(u)) return false;
  if (/\/year-in-(?:theater|review)/i.test(u)) return false;
  if (/best-(?:plays?|musicals?|shows?)-of-\d{4}/i.test(u)) return false;

  // Wrong medium — film/TV/movie reviews under same title.
  if (/\/film[\/s-]/i.test(u)) return false;
  if (/\/films[\/s-]/i.test(u)) return false;
  if (/\/movies?[\/s-]/i.test(u)) return false;
  if (/variety\.com\/\d+\/film\//i.test(u)) return false;
  if (/\/tv-?(?:plus|review|shows)\b/i.test(u)) return false;
  if (/apple-?tv-?(?:plus|review)?/i.test(u)) return false;

  // Wrong production / wrong subject markers.
  if (/regional-legit-review|stratford-festival|actors-?gang|national-theatre-tour|tour-review|restaurant\b/i.test(u)) return false;

  // Must look like an individual review URL (path token "review").
  if (!/[\/-]review[s\/-]?/.test(u) && !/[\/-]reviewed?[\/-]/.test(u)) return false;

  // Title tokens must overlap URL slug.
  const titleTokens = _wrongShowTitleTokens(show.title);
  if (titleTokens.length === 0) return false;
  const urlTokens = new Set(_wrongShowTitleTokens(url));
  let overlap = 0;
  for (const t of titleTokens) if (urlTokens.has(t)) overlap++;
  if (titleTokens.length === 1 && overlap < 1) return false;
  if (titleTokens.length > 1 && overlap < 2) return false;

  // Show title must appear as a phrase in fullText.
  if (!fullText.toLowerCase().includes(String(show.title).toLowerCase())) return false;

  // Year alignment — when both URL and show have a year, must be within 3.
  // For shows older than 2005, require URL year to be present (older revivals
  // commonly cross-attribute critics from later productions).
  const urlYearMatch = url.match(/[\/_-](20\d{2}|19\d{2})\b/);
  const urlYear = urlYearMatch ? parseInt(urlYearMatch[1], 10) : null;
  let showYear = null;
  if (show.openingDate) {
    const m = String(show.openingDate).match(/^(\d{4})/);
    if (m) showYear = parseInt(m[1], 10);
  }
  if (!showYear && show.id) {
    const m = String(show.id).match(/(\d{4})\b/);
    if (m) showYear = parseInt(m[1], 10);
  }
  if (urlYear && showYear && Math.abs(urlYear - showYear) > 3) return false;
  if (showYear && showYear < 2005 && !urlYear) return false;

  return true;
}

/**
 * Detect a stale wrongProduction=true flag on a file that actually contains
 * a substantial individual critic review of THIS production. Mirrors
 * isLikelyStaleWrongShow's structure — conservative whitelist; the companion
 * sweep script (scripts/clear-stale-wrong-production-flags.js) layers an LLM
 * second-opinion before clearing the flag on disk.
 *
 * Background (Notion 34e637c5-416f-811d, Session 5 of multi-flag audit):
 * wrongProduction is set by 4 paths —
 *   (1) date-vs-opening guard (>30d before show, >Nyrs after closing),
 *   (2) URL/venue mismatch (cross-market, regional outlet),
 *   (3) LLM ensemble rejection (rejectedAt + reason='wrong_production'),
 *   (4) cross-attribution audit + retroactive Haiku reverify.
 * Most ~15k flagged files are CORRECTLY flagged (tour reviews, regional
 * tryouts, cross-Atlantic transfers, prior revivals). Stale subset is a
 * minority where the producing logic was tightened or the override marker
 * was set but the flag persisted.
 *
 * Existing manual-clear paths (4 gate sites already honor these):
 *   - wrongProductionManualClear === true
 *   - wrongProductionOverride === true
 *   - humanReviewedWrongProduction === false
 * The sweep sets `wrongProduction = false` directly so the bare gate checks
 * (is-scoreable.js:12, review-text-scoreable.js:49, llm-scoring/is-scoreable.ts:15)
 * also pass without further refactor — and writes wrongProductionManualClear=true
 * as a durable breadcrumb so future audit/restore-protected-fields don't
 * re-flag the file.
 *
 * Manual-sample precision (10 files, 2026-04-26): 7/10 = 70% with
 * URL+date+title-overlap; 8/9 = 87.5% after requiring URL year alignment.
 * LLM second-opinion in the sweep should lift to ~95%+ before any disk write.
 *
 * Predicate is STRICTER than isLikelyStaleWrongShow — wrongProduction is
 * fundamentally about "wrong production of same play," so URL year alignment
 * + publishDate within show's run window are MANDATORY (not OR). URL-only
 * matches without date support are dominated by tour/revival reviews of
 * other productions and need the LLM to disambiguate.
 *
 * @param {object} data - Review-text JSON
 * @param {object} [show] - Show entry from shows.json (needs title +
 *   openingDate + status; uses closingDate when present)
 */
function isLikelyStaleWrongProduction(data, show) {
  if (!data || data.wrongProduction !== true) return false;
  if (!show || !show.title || String(show.title).length < 5) return false;

  // Already manually cleared — don't double-process; the sweep would be a no-op.
  if (data.wrongProductionManualClear === true) return false;
  if (data.wrongProductionOverride === true) return false;
  if (data.humanReviewedWrongProduction === false) return false;

  const fullText = String(data.fullText || '').trim();
  if (fullText.length < 1500) return false;

  // Don't override stronger signals from sibling guards.
  if (data.wrongShow === true) return false;
  if (data.fullTextWrongAuthor === true) return false;
  if (
    data.contentVerification &&
    data.contentVerification.wrongArticle === true &&
    data.contentVerification.confidence === 'high'
  ) return false;
  // Honor non-wrong_production rejection reasons (wrong_show, garbage_text,
  // not_a_review are different signals — leave them alone).
  if (data.rejectionReason && data.rejectionReason !== 'wrong_production') return false;

  const url = data.url || data.sourceUrl || '';
  if (!url) return false;
  const u = url.toLowerCase();

  // Roundup / multi-show / feature article URLs — never individual reviews.
  if (isRoundupUrl(url).isRoundup) return false;
  if (/\/article\/review-roundup-/i.test(u)) return false;
  if (/\/article\/reviews-sound-off-/i.test(u)) return false;
  if (/\/article\/reviews-/i.test(u)) return false;
  if (/playbill\.com\/article\/reviews-/i.test(u)) return false;
  if (/westendtheatre\.com\/.*\/reviews-of-/i.test(u)) return false;
  if (/\/review-roundup\//i.test(u)) return false;
  if (/\/reviews?-roundup\b/i.test(u)) return false;
  if (/broadway-shockers-\d{4}/i.test(u)) return false;
  if (/\/year-in-(?:theater|review)/i.test(u)) return false;
  if (/best-(?:plays?|musicals?|shows?)-of-\d{4}/i.test(u)) return false;

  // Tour / regional / wrong-venue indicators — these are LEGITIMATE wrong-production.
  if (/national-tour|tour-review|tour-and-regional|regional-(?:legit-)?review/i.test(u)) return false;
  if (/stratford-festival|actors-?gang|kennedy-center|world-premiere|world\.premiere/i.test(u)) return false;
  if (/[-/]tour[-/]|broadway-in-/i.test(u)) return false;
  if (/(?:[\/-])(?:knoxville|nashville|st-louis|orlando|tampa|cleveland|cincinnati|portland-or|minneapolis|milwaukee|baltimore|pittsburgh|las-vegas|orange-county|sarasota|charlotte|raleigh|hartford|providence|albany|buffalo|rochester|syracuse)(?:[\/-])/i.test(u)) return false;
  if (/arts-?(?:knoxville|nashville|memphis|atlanta)/i.test(u)) return false;

  // Wrong medium — film/TV reviews under same title.
  if (/\/film[\/s-]/i.test(u)) return false;
  if (/\/films[\/s-]/i.test(u)) return false;
  if (/\/movies?[\/s-]/i.test(u)) return false;
  if (/variety\.com\/\d+\/film\//i.test(u)) return false;
  if (/\/tv-?(?:plus|review|shows)\b/i.test(u)) return false;
  if (/apple-?tv-?(?:plus|review)?/i.test(u)) return false;

  // Must look like an individual review URL (path token "review").
  if (!/[\/-]review[s\/-]?/.test(u) && !/[\/-]reviewed?[\/-]/.test(u)) return false;

  // Title tokens must overlap URL slug (re-use wrongShow's tokenizer).
  const titleTokens = _wrongShowTitleTokens(show.title);
  if (titleTokens.length === 0) return false;
  const urlTokens = new Set(_wrongShowTitleTokens(url));
  let overlap = 0;
  for (const t of titleTokens) if (urlTokens.has(t)) overlap++;
  if (titleTokens.length === 1 && overlap < 1) return false;
  if (titleTokens.length > 1 && overlap < 2) return false;

  // Show title must appear as a phrase in fullText.
  if (!fullText.toLowerCase().includes(String(show.title).toLowerCase())) return false;

  // Year alignment — STRICT for wrongProduction. If URL has year, it must be
  // within 1 year of show opening year. URL year mismatch is the strongest
  // single signal that this is a different production of the same play
  // (e.g. arts-knoxville/2024/wicked review under wicked-2003).
  const urlYearMatch = url.match(/[\/_-](20\d{2}|19\d{2})\b/);
  const urlYear = urlYearMatch ? parseInt(urlYearMatch[1], 10) : null;
  let showYear = null;
  if (show.openingDate) {
    const m = String(show.openingDate).match(/^(\d{4})/);
    if (m) showYear = parseInt(m[1], 10);
  }
  if (!showYear && show.id) {
    const m = String(show.id).match(/(\d{4})\b/);
    if (m) showYear = parseInt(m[1], 10);
  }
  if (urlYear && showYear && Math.abs(urlYear - showYear) > 1) return false;
  // Pre-2005 shows: require URL year (older catalog has high cross-attribution risk).
  if (showYear && showYear < 2005 && !urlYear) return false;

  // publishDate must be within show's run window (allow -30d before opening
  // for previews, +14d after closing for late reviews). MANDATORY for
  // wrongProduction — distinguishes "this run" from "different run of same play".
  if (!show.openingDate || !data.publishDate) return false;
  const openDate = new Date(show.openingDate);
  const pd = new Date(data.publishDate);
  if (isNaN(openDate) || isNaN(pd)) return false;
  let endDate;
  if (show.closingDate) {
    endDate = new Date(show.closingDate);
  } else if (show.status === 'open') {
    endDate = new Date();
  } else {
    endDate = new Date(openDate.getTime() + 365 * 86400000);
  }
  const earliest = new Date(openDate.getTime() - 30 * 86400000);
  const latest = new Date(endDate.getTime() + 14 * 86400000);
  if (pd < earliest || pd > latest) return false;

  return true;
}

/**
 * Self-heal a stale CV-promoted wrongProduction flag.
 *
 * CV promotion (rebuild-all-reviews.js) is one-directional: a pass sets
 * data.wrongProduction=true from contentVerification, but a LATER re-verification
 * that flips contentVerification.wrongProduction back to false never clears the
 * top-level flag. The review then stays excluded even though the current
 * authoritative CV says it is NOT a wrong production.
 *
 * Root cause of the Romeo & Juliet (Shakespeare in the Park) NY Stage Review
 * drop (2026-06-15): nysr--roma-torre had wrongProduction=true /
 * "CV-promoted: This is a legitimate review…" while contentVerification.
 * wrongProduction=false (confidence high, claude-haiku). The periodic
 * isLikelyStaleWrongProduction sweep missed it (truncated text < 1500 chars,
 * and it only runs as a separate LLM script — not in the rebuild).
 *
 * This predicate is PROVENANCE-GATED: it only clears flags whose reason shows
 * they were set by CV itself ("CV-promoted:" / "CV-low-but-strong-signal:"),
 * so it never touches wrongProduction set by the date-vs-opening guard, the
 * ensemble-rejection path, or tour/cross-market guards — those have their own
 * (non-CV) reasons and a CV record saying false does not invalidate them.
 *
 * It additionally requires INDEPENDENT corroboration — a high/medium-confidence
 * ensemble score on this review — because CV records can disagree with each
 * other. The Titus Andronicus OB 2026 case (2026-06-15 probe) is a NYT dual
 * review of Teatro La Plaza's *Hamlet* misfiled under Titus: an early CV pass
 * correctly flagged it ("a review of … Hamlet … not Titus"), but a later pass
 * wrongly set contentVerification.wrongProduction=false. It had NO ensemble
 * score, so the corroboration gate keeps it excluded. The genuine false
 * positive (R&J NYSR) carried a confident score of 79.
 *
 * The caller passes cvIsStale (text changed after verification) so the single
 * staleness computation in the rebuild loop is reused rather than duplicated.
 *
 * @param {object} data - Review-text JSON
 * @param {boolean} cvIsStale - true when fullText was fetched/changed after the
 *   contentVerification ran (caller-computed via timestamp + contentHash)
 * @returns {boolean} true when the stale CV-promoted flag should be cleared
 */
function isStaleCvPromotedWrongProduction(data, cvIsStale) {
  if (!data || data.wrongProduction !== true) return false;
  if (cvIsStale) return false;

  // Provenance gate: only self-heal flags CV itself set.
  const reason = String(data.wrongProductionReason || '');
  if (!/^CV-promoted:|^CV-low-but-strong-signal:/.test(reason)) return false;

  // Never re-touch a human/manual decision (and avoid no-op churn).
  if (data.wrongProductionManualClear === true) return false;
  if (data.wrongProductionOverride === true) return false;
  if (data.humanReviewedWrongProduction === false) return false;

  // Don't override stronger sibling guards.
  if (data.wrongShow === true) return false;
  if (data.rejectionReason && data.rejectionReason !== 'wrong_production') return false;

  // The current authoritative CV must affirm NOT wrong-production AND NOT
  // wrong-article (wrong show) at HIGH confidence. High-only is deliberate:
  // the promotion path treats ensemble-confident + medium-CV wrongProduction as
  // merely "advisory" and requires high confidence to act (rebuild-all-reviews
  // CV block) — the clear path must be at least as strict, so we never undo a
  // flag on weaker evidence than it took to set one.
  const cv = data.contentVerification;
  if (!cv) return false;
  if (cv.wrongProduction !== false) return false;
  if (cv.wrongArticle === true) return false;
  if (cv.confidence !== 'high') return false;

  // Independent corroboration: the ensemble scored this as a real review at
  // high/medium confidence. Note this confirms "is a scoreable review", not
  // "is the right production" — it is a secondary guard, not the primary one;
  // the primary signal is the high-confidence CV record. Together they guard
  // against CV-vs-CV disagreement restoring a misfiled wrong-show review that
  // happens to carry a stale "wrongProduction=false" record (e.g. the Titus
  // Andronicus / misfiled-Hamlet case, which has no ensemble score).
  if (!hasHighConfidenceLlmScore(data)) return false;

  return true;
}

/**
 * Detect a stale suspectedMisattribution flag — a flag that the current
 * critic-registry would no longer set on this file.
 *
 * Background (Notion 34e637c5-416f-81b8): suspectedMisattribution is set by
 * Guard G in scripts/lib/review-file-writer.js when a non-freelancer critic
 * publishes at an outletId outside their knownOutlets. The check is gated by
 * `entry && !entry.isFreelancer && knownOutlets.length > 0` — if any of those
 * is false today, Guard G would no longer fire on the same file.
 *
 * The registry is regenerated nightly by scripts/audit-critic-outlets.js from
 * the current corpus, so knownOutlets expands over time as critics accumulate
 * reviews at additional outlets. Files flagged in earlier passes carry the
 * exclusion forever, even after the registry has caught up.
 *
 * Whitelist by registry-state-today, mirroring the exact preconditions of
 * Guard G:
 *   - critic is no longer in registry (entry undefined → guard short-circuits)
 *   - critic is now classified as freelancer (guard skips)
 *   - outletId is now in knownOutlets (guard passes)
 *
 * Slug + outlet contract: predicate uses the SAME normalization functions as
 * Guard G (normalizeCritic — strips honorifics + applies CRITIC_ALIASES) and
 * the same outlet canonicalization that audit-critic-outlets.js writes into
 * knownOutlets (normalizeOutlet). Without this, an aliased critic name or a
 * pre-canonical outletId would mis-look-up the registry and silently un-flag
 * real misattributions (caught in /ship-check 2026-04-26).
 *
 * Empty-registry fail-safe: if the registry is empty (broken symlink, missing
 * file), the predicate returns false on every flagged file — preserves the
 * existing flag rather than blanket-clearing the entire corpus when it cannot
 * prove anything. getCriticRegistry() also logs a warning on load failure.
 *
 * @param {Object} data - Review-text record
 * @param {Object|undefined} registry - critic-registry critics map (slug → entry).
 *   Pass `getCriticRegistry()` from this file. Empty/null/undefined registry
 *   makes the predicate return false everywhere.
 */
function isLikelyStaleSuspectedMisattribution(data, registry) {
  if (!data || data.suspectedMisattribution !== true) return false;
  if (!registry || typeof registry !== 'object') return false;
  if (Object.keys(registry).length === 0) return false; // Empty-registry fail-safe.
  const criticName = (data.criticName || '').trim();
  const outletId = (data.outletId || '').trim();
  if (!criticName || !outletId || criticName === 'Unknown' || outletId === 'unknown') return false;
  // Lazy require to avoid load-time cycles; matches the file's pattern (lines 294, 323).
  const { normalizeCritic, normalizeOutlet } = require('./review-normalization');
  // Use Guard G's exact normalization (review-file-writer.js:261) — handles
  // honorific prefix stripping (CSA./MR./MS./DR.) and CRITIC_ALIASES canonicalization.
  const slug = normalizeCritic(criticName);
  if (!slug || slug === 'unknown') return false;
  const entry = registry[slug];
  if (!entry) return true; // Critic dropped from registry — Guard G would short-circuit.
  if (entry.isFreelancer === true) return true; // Freelancer — Guard G skips.
  const knownOutlets = entry.knownOutlets || [];
  if (knownOutlets.length === 0) return true; // No knownOutlets — Guard G's `length > 0` check fails.
  // Compare canonical outletId — audit-critic-outlets.js writes normalizeOutlet
  // values into knownOutlets, so a pre-canonical outletId on the file must be
  // canonicalized for the includes() check to be meaningful. Also check raw
  // outletId for backwards compatibility with any legacy registry rows.
  const canonicalOutlet = normalizeOutlet(outletId);
  if (knownOutlets.includes(canonicalOutlet) || knownOutlets.includes(outletId)) return true;
  return false;
}

/**
 * Lazy-load critic-registry from disk for use in pure-flag exclusion gates.
 * Cached at module scope; call _resetCriticRegistryCache() in tests if needed.
 *
 * On read failure (missing file, broken symlink, parse error), logs a warning
 * once and returns an empty object. The predicate treats empty registry as
 * "cannot prove staleness" — a missing/corrupt registry must NOT silently
 * un-flag the corpus (would be the inverse of the bug we're fixing).
 */
let _criticRegistryCache = null;
let _criticRegistryWarned = false;
function getCriticRegistry() {
  if (_criticRegistryCache !== null) return _criticRegistryCache;
  try {
    const path = require('path');
    const fs = require('fs');
    const registryPath = path.join(__dirname, '..', '..', 'data', 'critic-registry.json');
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    _criticRegistryCache = raw.critics || {};
    if (Object.keys(_criticRegistryCache).length === 0 && !_criticRegistryWarned) {
      console.warn('  ⚠️  critic-registry loaded but empty — stale-misattribution gate disabled');
      _criticRegistryWarned = true;
    }
  } catch (e) {
    if (!_criticRegistryWarned) {
      console.warn(`  ⚠️  critic-registry load failed (${e.message}) — stale-misattribution gate disabled`);
      _criticRegistryWarned = true;
    }
    _criticRegistryCache = {};
  }
  return _criticRegistryCache;
}

function _resetCriticRegistryCache() {
  _criticRegistryCache = null;
  _criticRegistryWarned = false;
}

/**
 * Detect URL/venue mismatches that suggest wrong production.
 * Checks if the review URL mentions a different venue than expected.
 *
 * @param {string} url - Review URL
 * @param {string} showVenue - Expected venue from shows.json
 * @param {string} showCategory - Show category (west-end, broadway, etc.)
 * @returns {{ isMismatch: boolean, reason?: string }}
 */
function isVenueMismatch(url, showVenue, showCategory) {
  if (!url || !showVenue) return { isMismatch: false };

  // Only check WE shows — Broadway venue matching is different
  if (showCategory !== 'west-end' && showCategory !== 'off-west-end') return { isMismatch: false };

  // Strip hostname so we only match URL path (avoids false positives from domain names)
  const urlPath = url.replace(/https?:\/\/[^/]+/, '').toLowerCase();

  // Each entry: [urlPattern, venueName, venueMatchPattern]
  // urlPattern matches the URL path; venueMatchPattern matches the show's actual venue.
  // If the URL matches but the venue does NOT match, it's a mismatch.
  const VENUE_CHECKS = [
    [/national-theatre|(?:^|[-/])dorfman(?:[-/]|$)|(?:^|[-/])lyttelton(?:[-/]|$)|(?:^|[-/])olivier-theatre/, 'National Theatre', /national theatre|dorfman|lyttelton|olivier theatre/i],
    [/chichester-festival|chichester-theatre/, 'Chichester Festival Theatre', /chichester/i],
    [/menier-chocolate/, 'Menier Chocolate Factory', /menier/i],
    [/donmar-warehouse/, 'Donmar Warehouse', /donmar/i],
    [/(?:^|[-/])almeida-theatre|[-/]almeida(?:[-/]|$)/, 'Almeida Theatre', /almeida/i],
    [/young-vic(?:[-/]|$)/, 'Young Vic', /young vic/i],
    [/(?:^|[-/])bridge-theatre/, 'Bridge Theatre', /bridge theatre/i],
    [/royal-court(?:-theatre)?/, 'Royal Court', /royal court/i],
    [/rose-theatre-kingston/, 'Rose Theatre Kingston', /rose theatre/i],
    [/waterloo-east/, 'Waterloo East Theatre', /waterloo east/i],
    [/hampstead-theatre/, 'Hampstead Theatre', /hampstead/i],
    [/bush-theatre/, 'Bush Theatre', /bush theatre/i],
  ];

  for (const [urlPattern, venueName, venueMatch] of VENUE_CHECKS) {
    if (urlPattern.test(urlPath)) {
      // Skip "bridge-theatre" matching "cambridge-theatre" (substring false positive)
      if (venueName === 'Bridge Theatre' && /cambridge/i.test(url)) continue;
      if (!venueMatch.test(showVenue)) {
        return { isMismatch: true, reason: 'URL mentions ' + venueName + ' but show venue is ' + showVenue };
      }
    }
  }

  return { isMismatch: false };
}

/**
 * Detect when a review URL's slug clearly names a different show than expected.
 * Catches cases where SERP discovery filed a review under the wrong show directory.
 *
 * @param {string} url - Review URL
 * @param {string} showTitle - Expected show title from shows.json
 * @returns {{ isMismatch: boolean, reason?: string, urlTitle?: string }}
 */
function isUrlTitleMismatch(url, showTitle) {
  if (!url || !showTitle) return { isMismatch: false };

  // Extract the likely show-title slug from the URL path
  // Common patterns: /review-TITLE-venue/, /TITLE-review/, /review/TITLE/
  const urlPath = url.replace(/https?:\/\/[^/]+/, '').toLowerCase();

  // Normalize show title to URL-slug form for comparison
  const titleSlug = showTitle.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Extract key words from show title (3+ char, non-common)
  const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'review', 'theatre', 'theater', 'musical', 'play', 'london', 'broadway', 'west', 'end', 'new', 'york']);
  const titleWords = titleSlug.split('-').filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  if (titleWords.length === 0) return { isMismatch: false };

  // Check if ANY significant title word appears in the URL path
  const matchCount = titleWords.filter(w => urlPath.includes(w)).length;
  const matchRate = matchCount / titleWords.length;

  // If zero title words match AND the URL path is long enough to contain a show name,
  // this is likely a wrong-show URL
  if (matchRate === 0 && urlPath.length > 30) {
    return { isMismatch: true, reason: 'URL contains none of the show title words (' + titleWords.join(', ') + ')' };
  }

  return { isMismatch: false };
}

/**
 * Like urlLooksLikeReview but ALSO accepts a match against the article title/H1.
 *
 * Critics often use creative review titles that don't repeat the show name in the URL —
 * Theater Pizzazz Ron Fassler's DoaS review URL is "hes-back-but-has-willy-loman-ever-left-us"
 * with no "death-of-a-salesman" in the URL slug. The strict urlLooksLikeReview rejected
 * the legit review on opening night.
 *
 * Resolution order:
 *   1. If options.trustedSource === true, accept (used by BWW Review Roundup extractor
 *      where the manual curation is the trusted signal).
 *   2. URL still has rejected patterns (/tag/, /author/, /ticket without /review): reject.
 *   3. URL slug matches the show title via urlLooksLikeReview: accept.
 *   4. articleTitle exists and contains enough title words: accept.
 *   5. Otherwise reject.
 *
 * @param {string} url - Review URL
 * @param {string} showTitle - Show title to match against
 * @param {string|null} articleTitle - Optional article H1 / og:title
 * @param {Object} [options]
 * @param {boolean} [options.trustedSource=false] - Bypass for trusted aggregators
 * @returns {boolean}
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #6
 */
function urlOrTitleLooksLikeReview(url, showTitle, articleTitle, options = {}) {
  if (!url) return false;
  // 1. trustedSource bypass (BWW Roundup curation) — but still check URL is article-shaped
  const lower = url.toLowerCase();
  // Reject obviously non-article URLs even with trustedSource (defense in depth)
  if (lower.includes('/tag/') || lower.includes('/author/') || lower.includes('/category/')) return false;
  if (lower.includes('/search') || lower.includes('/obituar')) return false;
  if (lower.includes('/page/') && !lower.includes('talkinbroadway.com/page/')) return false;
  if (lower.includes('ticket') && !lower.includes('review')) return false;

  if (options.trustedSource === true) return true;

  // 2. Try the strict slug check first (cheaper)
  if (urlLooksLikeReview(url, showTitle)) return true;

  // 3. Fall back to article title match if provided
  if (articleTitle && typeof articleTitle === 'string' && articleTitle.trim().length > 0) {
    // Reuse urlLooksLikeReview's word-matching by treating articleTitle as if it were a URL
    // This gives us free word-boundary checking and the same significant-word filter.
    if (urlLooksLikeReview(articleTitle, showTitle)) return true;
  }

  return false;
}

/**
 * Returns true if a wrongShow file should be locked against URL re-assignment
 * because both the existing file's critic and the incoming review's critic
 * normalize to "unknown."
 *
 * The DoaS Apr 9-10 postmortem (#13) showed an RSS feed loop where
 * variety--unknown.json kept getting new wrong URLs assigned to it because:
 *   1. RSS discovery couldn't extract a critic name (criticName = "Unknown")
 *   2. The existing file was already wrongShow=true (from a prior bad URL)
 *   3. The incoming review key (outletId + "unknown") matched the existing key
 *   4. The "wrongShow + URL change" replace branch fired, wiping the wrongShow
 *      flag and stamping a new (also wrong) URL
 *   5. Next cycle: repeat with another wrong URL
 *
 * Outlet+"unknown" is too weak an identity match to claim "same review, just a
 * new URL." When BOTH sides are unknown-critic, refuse the URL re-assignment
 * and preserve the existing file as-is. Site search and SERP layers can still
 * discover the correct URL with a NAMED critic, which falls into the existing
 * unknown→named upgrade path (gather-reviews.js:2511) — that's not blocked.
 *
 * @param {Object|null} existing - Existing review data on disk
 * @param {Object|null} incoming - New review data being merged
 * @returns {boolean} true if the URL re-assignment should be blocked
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #13
 */
function isWrongShowUnknownLocked(existing, incoming) {
  if (!existing || typeof existing !== 'object') return false;
  if (!incoming || typeof incoming !== 'object') return false;
  if (existing.wrongShow !== true) return false;
  const existingCritic = (existing.criticName || '').trim().toLowerCase();
  const incomingCritic = (incoming.criticName || '').trim().toLowerCase();
  const isUnknown = (c) => c === '' || c === 'unknown' || c === 'unnamed';
  return isUnknown(existingCritic) && isUnknown(incomingCritic);
}

/**
 * Centralized check for whether the wrong-production audit should skip a review file.
 *
 * Returns true if any of the three "human-verified positive" overrides is set:
 *   - humanReviewedWrongProduction === false (explicit human verification)
 *   - wrongProductionManualClear === true
 *   - wrongProductionOverride === true
 *
 * Use this at every site in rebuild-all-reviews.js that writes wrongProduction = true.
 * Without it, CV-pre-pass and other guards re-flag human-verified files (the DoaS Apr 9-10
 * bug class — see memory/project_doas_opening_night_issues.md issue #10).
 *
 * Strict equality is intentional: the override is the literal value `false`, not just
 * any falsy value. A missing/null/undefined humanReviewedWrongProduction means "not yet
 * human-verified" and the audit should run normally.
 *
 * @param {Object|null} data - Review data object (from review-texts JSON file)
 * @returns {boolean} true if the audit should skip this file
 */
function shouldSkipWrongProductionAudit(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    data.humanReviewedWrongProduction === false ||
    data.wrongProductionManualClear === true ||
    data.wrongProductionOverride === true ||
    data.allowCrossMarket === true
  );
}

/**
 * Should a CROSS-SHOW-URL-COLLISION flagger skip flagging this review wrongProduction?
 *
 * Cross-show URL collision flaggers (gather-reviews.js ingest + rebuild-all-reviews.js
 * rebuild) decide which of N sibling productions owns a SHARED review URL using a weak
 * year-distance heuristic (review-year closer to production-year wins). That heuristic
 * must not override the STRONG signal: content verification. When CV read the review
 * text and affirmed it belongs to THIS production
 * (contentVerification.wrongProduction === false), the heuristic is wrong to flag it —
 * and the B_false_positive_wp audit will (correctly) fail on it every rebuild. Honoring
 * CV at the flagging site kills that whac-a-mole class at the source. Also honors the
 * usual manual-clear / override breadcrumbs via shouldSkipWrongProductionAudit.
 *
 * Scoped to the cross-show-URL heuristic only — other wrongProduction setters
 * (date-guard, pre-opening) have different semantics and intentionally do NOT defer
 * to CV here.
 */
// `contentVerification.wrongProduction === false` is only an affirmative verdict when a
// PRODUCTION-AWARE verifier wrote it. content-verifier.js's heuristic/skip-short paths
// default it to false ("Heuristics can't reliably detect this") — those must NOT count.
function isProductionAwareCvVerdict(cv) {
  if (!cv || cv.wrongProduction !== false) return false;
  const v = cv.verifiedBy;
  return typeof v === 'string' && (v.startsWith('llm:') || v.startsWith('human') || v === 'manual');
}

function shouldSkipCrossShowUrlFlag(data) {
  if (!data || typeof data !== 'object') return false;
  if (shouldSkipWrongProductionAudit(data)) return true;
  if (isProductionAwareCvVerdict(data.contentVerification)) return true;
  return false;
}

/**
 * Returns true if an isRoundupArticle setter should skip this file because
 * a human has manually cleared the flag (clear-stale-roundup-flags.js sets
 * isRoundupArticle=false and roundupArticleClearedNote). Without this guard,
 * CI setter scripts re-flag within one cycle.
 *
 * @param {Object|null} data - Review data object
 * @returns {boolean} true if the setter should skip this file
 */
function shouldSkipRoundupAudit(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    data.isRoundupArticle === false ||
    data.roundupArticleClearedNote !== undefined
  );
}

// Hosts whose isRoundupUrl patterns identify roundup PAGES, mapped to the
// outletIds that publish on that host. A review file whose own outletId
// belongs to the host of its roundup URL IS the roundup page ingested as a
// review (page-as-review). A file with a different outletId (e.g. times-uk
// with a westendtheatre.com URL) is a review SOURCED from the roundup and
// stays includable — see the NOTE in isRoundupUrl.
const ROUNDUP_HOST_OUTLETS = {
  'whatsonstage.com': ['whatsonstage', 'whats-on-stage'],
  'playbill.com': ['playbill'],
  // Policy decided 2026-07-11 (user): a NAMED CRITIC reviewing the show
  // counts; a site's AGGREGATED score does not. isRoundupUrl matches only
  // these hosts' aggregate/roundup pages — never their individual critic
  // review posts (Stage /reviews/, LBO /news/post/<show>-review, WET
  // per-outlet rows carry the OUTLET's id, not the host's) — so
  // page-as-review on these hosts is by definition an aggregated score
  // dressed as a review. Named-byline reviews at individual URLs are
  // unaffected. Cleanup: dropped WET editorial 77-97 entries (cyrano,
  // abba-voyage, much-ado, the-truth) + thestage--unknown 64 stub.
  'thestage.co.uk': ['thestage', 'the-stage'],
  'londonboxoffice.co.uk': ['london-box-office', 'londonboxoffice'],
  'westendtheatre.com': ['westendtheatre', 'west-end-theatre', 'west-end-theatre-editorial'],
  // BroadwayWorld's /reviews/{slug} page (see isRoundupUrl) — a critics-average
  // widget quoting other outlets, not an individual BWW review. BWW's OWN
  // reviews live at /article/BWW-Review-... and are unaffected.
  'broadwayworld.com': ['broadwayworld', 'broadway-world', 'bww', 'broadwayworldcom'],
};

/**
 * Inclusion-time roundup gate. The isRoundupArticle flag setter only runs in
 * full-enrichment rebuilds; fast_path/skip_enrichment rebuilds (the common
 * case — every poller cycle) shipped unflagged roundup pages as reviews:
 * 4 live entries found 2026-07-09 (hamilton-west-end-2021, les-miserables-
 * west-end-2021, one-flew-over-the-cuckoos-nest-west-end-2026, the-truth
 * WOS). This predicate needs no prior enrichment pass — it derives the
 * verdict from the URL + outletId alone. Honors manual clears.
 *
 * @param {Object|null} data - Review data object
 * @returns {boolean} true when the file is a roundup page ingested as a review
 */
function roundupGatedHostFor(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch { return null; }
  for (const gated of Object.keys(ROUNDUP_HOST_OUTLETS)) {
    if (host === gated || host.endsWith(`.${gated}`)) return gated; // covers www./m./amp. subdomains
  }
  return null;
}

/**
 * True when the URL's host is one of the "quoting" roundup hosts (WOS,
 * Playbill) — hosts whose roundups quote OTHER outlets' critics, so a
 * roundup URL there is only page-as-review when the file's own outletId
 * belongs to the host. Used by rebuild's auto-setter to avoid flagging
 * reviews merely SOURCED from those roundups (e.g. times-uk rows).
 */
function isQuotingRoundupHostUrl(url) {
  return roundupGatedHostFor(url) !== null;
}

function isRoundupPageAsReview(data) {
  if (!data || typeof data !== 'object' || !data.url) return false;
  if (shouldSkipRoundupAudit(data)) return false;
  if (!isRoundupUrl(data.url).isRoundup) return false;
  const gated = roundupGatedHostFor(data.url);
  if (!gated) return false;
  return ROUNDUP_HOST_OUTLETS[gated].includes((data.outletId || '').toLowerCase());
}

// Non-review articleType values from content-verifier.js's enum
// ("review"/"preview"/"interview"/"news"/"feature"/"box-office"/"obituary"/"listicle"/"other").
// "other" is deliberately absent — too ambiguous to block a clear on.
const NON_REVIEW_ARTICLE_TYPES = ['preview', 'interview', 'news', 'feature', 'box-office', 'obituary', 'listicle'];

/**
 * True when contentVerification is strong enough evidence against the review
 * to block the rebuild's "UK URL on London show" wrongProduction auto-clear.
 * articleType carries its own confidence, separate from the overall CV
 * confidence: the Times Sam Ryder interview (JCS Palladium, 2026-07-08) had
 * wrongArticle=true at overall confidence=low (ignored) while
 * articleType=interview was high-confidence (unused) — the cleared file
 * scored 70 as a T1 review on opening morning.
 *
 * @param {Object|null} cv - data.contentVerification
 * @returns {boolean} true when the auto-clear must NOT strip wrongProduction
 */
function cvBlocksUkWrongProductionAutoClear(cv) {
  if (!cv || typeof cv !== 'object') return false;
  if (cv.wrongProduction === true && cv.confidence === 'high') return true;
  if (cv.wrongArticle === true && cv.confidence === 'high') return true;
  if (cv.articleTypeConfidence === 'high' && NON_REVIEW_ARTICLE_TYPES.includes(cv.articleType)) return true;
  return false;
}

/**
 * Returns true if the show is a revival of an earlier-titled production.
 *
 * Revival = another show in shows.json shares the same `title` (or `canonicalTitle`)
 * but a different show ID. This is more reliable than year-suffix regex because TodayTix
 * IDs use varied suffixes: `-2026`, `-2`, no suffix at all (e.g. `giant-2`, `death-of-a-salesman`).
 *
 * Used by the revival heuristic gate in content-quality.js — when a review's text mentions
 * actors/details from a prior production of the same title, the LLM should NOT trip
 * "different show mentioned" because the prior production IS the same play, just a
 * different cast/year.
 *
 * @param {string} showId - The show ID being checked (e.g. "death-of-a-salesman-2026")
 * @param {Array} shows - Array of show records (typically from shows.json)
 * @returns {boolean} true if at least one OTHER show shares the same canonical title
 */
function isRevivalByCanonicalTitle(showId, shows) {
  if (!showId || !Array.isArray(shows) || shows.length === 0) return false;
  const target = shows.find(s => s && s.id === showId);
  if (!target) return false;
  const targetTitle = (target.canonicalTitle || target.title || '').toLowerCase().trim();
  if (!targetTitle) return false;
  for (const s of shows) {
    if (!s || s.id === showId) continue;
    const t = (s.canonicalTitle || s.title || '').toLowerCase().trim();
    if (t === targetTitle) return true;
  }
  return false;
}

/**
 * Show-mention heuristic guard.
 *
 * The heuristic show-mention check (validateShowMentioned) is a fast, fragile
 * fallback for when LLM verification was skipped or unavailable. It checks
 * whether the show title appears in the article body. The check has two
 * well-known failure modes:
 *
 *   (1) Paywalled outlets (Times UK, FT, Telegraph, NYT) often return only
 *       the lede + first paragraphs, which may use a metaphorical opening
 *       and never name the show. The collector then nulls fullText and the
 *       review is silently dropped from scoring.
 *
 *   (2) The collector previously derived the title from the showId
 *       (e.g. "dracula-west-end-2025" → "dracula west end") rather than the
 *       canonical title in shows.json ("Dracula"). For multi-word slugs,
 *       this caused validateShowMentioned to look for the wrong string.
 *
 * This guard codifies the rules that should govern WHEN the heuristic is
 * allowed to fire and what to do about prior runs that already left damage:
 *
 *   - The text must be substantive enough for the heuristic to be reliable
 *     (≥250 words AND ≥1500 chars). Below that, the lede may legitimately
 *     omit the title and we should defer to LLM verification or aggregator
 *     scores instead of nulling fullText.
 *
 *   - If the review is alreadyScored (has a valid 1-100 assignedScore from
 *     a trusted aggregator), the heuristic must NOT null fullText. The score
 *     is the source of truth; the heuristic only flags for human review.
 *     Additionally, this branch must CLEAR any stale showNotMentioned /
 *     wrongFullText damage from prior runs (before the alreadyScored guard
 *     existed) so the file recovers automatically.
 *
 *   - The canonical title from shows.json should be preferred over the
 *     showId-derived title.
 *
 * @param {Object} review - Review file data
 * @param {string} cleanedText - Text after cleanText() has run
 * @param {number} cleanedWordCount - Word count of cleanedText
 * @param {{ valid: boolean, confidence: string, reason?: string }} showCheck
 *   - Result of validateShowMentioned() (or equivalent)
 * @returns {{ action: 'skip' | 'flag-needs-review' | 'null-text', reason?: string, repairStaleFlags: boolean }}
 *   - 'skip': context is too thin OR title was found — do nothing
 *   - 'flag-needs-review': set needsReview=true, leave fullText alone, and clear
 *     any stale showNotMentioned / wrongFullText / restore fullText if it was nulled
 *   - 'null-text': move fullText → wrongFullText and null fullText (legacy behavior,
 *     only applies to unscored reviews with substantive text)
 */
function evaluateShowMentionGuard(review, cleanedText, cleanedWordCount, showCheck) {
  // Context-too-thin gate: heuristic is unreliable on short paywalled excerpts
  // where the lede may legitimately omit the show title (metaphorical opening,
  // anecdotal lede, performance-focused lede, etc.).
  const charCount = (cleanedText || '').length;
  const HEURISTIC_MIN_CHARS = 1500;
  const HEURISTIC_MIN_WORDS = 250;
  if (charCount < HEURISTIC_MIN_CHARS || cleanedWordCount < HEURISTIC_MIN_WORDS) {
    return {
      action: 'skip',
      reason: `context too thin (${cleanedWordCount} words / ${charCount} chars < ${HEURISTIC_MIN_WORDS}w/${HEURISTIC_MIN_CHARS}c)`,
      repairStaleFlags: false,
    };
  }

  // showCheck either passed or wasn't decisive — nothing to do
  if (!showCheck || showCheck.valid || showCheck.confidence !== 'high') {
    return { action: 'skip', repairStaleFlags: false };
  }

  // alreadyScored guard: never destroy a review that has a trusted aggregator score.
  // Also clear any stale damage from prior runs (before this guard existed).
  const alreadyScored = !!(review.assignedScore && review.assignedScore >= 1 && review.assignedScore <= 100);
  if (alreadyScored) {
    return {
      action: 'flag-needs-review',
      reason: showCheck.reason || 'show title not found in text',
      repairStaleFlags: true,
    };
  }

  return {
    action: 'null-text',
    reason: showCheck.reason || 'show title not found in text',
    repairStaleFlags: false,
  };
}

/**
 * Pick the canonical show title for heuristic checks.
 *
 * Prefers the title from shows.json (e.g. "Dracula") over the showId-derived
 * fallback ("dracula west end") because the latter contains market suffixes
 * that the article body never uses.
 *
 * @param {string} showId - Show ID (e.g. "dracula-west-end-2025")
 * @param {Object|null} showMeta - Show entry from shows.json (or null if unavailable)
 * @returns {string} Title to pass to validateShowMentioned
 */
function pickShowTitleForHeuristic(showId, showMeta) {
  if (showMeta && typeof showMeta.title === 'string' && showMeta.title.trim().length > 0) {
    return showMeta.title;
  }
  return (showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ');
}

/**
 * Build a keyword set for "does this text look like it's about this show" checks.
 *
 * Used as a final-mile guard before auto-restoring a wrongFullText → fullText.
 * The rebuild auto-clear trusts a prior LLM verification (verifiedBy=llm:gemini,
 * isValid:true), but LLMs hallucinate isValid:true on garbage pages — browser-update
 * prompts, paywall walls, sidebar story lists, even wrong-show content. Without
 * this final check, the auto-clear restores junk as the canonical fullText.
 *
 * Keywords include: full lowercased title, individual title words ≥3 chars (minus
 * stopwords), top 5 cast surnames (≥4 chars), top 3 director surnames, venue words.
 *
 * @param {Object} show - shows.json entry
 * @returns {Set<string>} Lowercased keywords
 */
function buildShowKeywordSet(show) {
  const keywords = new Set();
  if (!show) return keywords;
  // Stopwords excluded from EVERY source (title words, cast surnames, creative team
  // surnames, venue words). Some shows have corrupted creative team data with sentence
  // fragments like "Gordon Greenberg is working with" → last word "with" would pollute
  // the keyword set otherwise.
  const STOP = new Set([
    'the','and','for','with','play','show','musical','broadway','london','westend','west','end','theatre','theater','from','that','this',
    // Common verb/preposition fragments that creep in from corrupted creative team data
    'working','person','people','from','have','will','been','were','their','about','into','onto','some','also','only','more','most','than','then','when','what','which','where','they','them','some','some',
  ]);
  const passes = (w) => w.length >= 3 && !STOP.has(w);
  const passesLong = (w) => w.length >= 4 && !STOP.has(w);

  const realTitle = (show.title || '').toLowerCase();
  if (realTitle.length >= 4) keywords.add(realTitle);
  for (const w of realTitle.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    if (passes(w)) keywords.add(w);
  }
  for (const c of (show.cast || []).slice(0, 5)) {
    if (!c.name) continue;
    const last = c.name.split(/\s+/).pop().toLowerCase();
    if (passesLong(last)) keywords.add(last);
  }
  for (const c of (show.creativeTeam || []).slice(0, 3)) {
    if (!c.name) continue;
    const last = c.name.split(/\s+/).pop().toLowerCase();
    if (passesLong(last)) keywords.add(last);
  }
  if (show.venue) {
    for (const w of show.venue.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
      if (w.length >= 5 && !STOP.has(w) && w !== 'theatre' && w !== 'theater') keywords.add(w);
    }
  }
  return keywords;
}

/**
 * Check if `text` mentions any keyword from `keywordSet`.
 * Long keywords (≥5 chars) use substring match; short keywords (<5) use word-boundary
 * regex to avoid "rent" matching "current" or "win" matching "winning".
 *
 * @param {string} text - Text to scan
 * @param {Set<string>} keywordSet - Keywords from buildShowKeywordSet()
 * @returns {string|null} The first matched keyword, or null if none matched
 */
function findShowKeywordInText(text, keywordSet) {
  if (!text || !keywordSet || keywordSet.size === 0) return null;
  const lower = text.toLowerCase();
  for (const k of keywordSet) {
    if (k.length >= 5) {
      if (lower.includes(k)) return k;
    } else {
      const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(text)) return k;
    }
  }
  return null;
}

/**
 * Check whether LLM-verified content also passes the keyword-mention gate.
 *
 * Why: LLM contentVerification hallucinates `isValid:true` ~48% of the time on
 * garbage pages (browser-update prompts, paywall walls, sidebar story lists,
 * wrong-show content). Trusting the LLM verdict alone has corrupted scoring
 * multiple times. See feedback_llm_verifier_hallucinates.md + the 15 ship-check
 * cases in Notion card 33f637c5-416f-814c-9102-f10a0849d986.
 *
 * Contract:
 *   - Returns `null` when the check is not applicable (no LLM verification,
 *     too-short text, no keywords available, LLM already flagged wrongArticle).
 *     Callers should fall through.
 *   - Returns `{ passed, matchedKeyword, keywordsChecked }` otherwise.
 *     `passed:false` means the LLM said valid but no show-identifying keyword
 *     appears in the text — high-confidence hallucination signal.
 *
 * Used by:
 *   - scripts/rebuild-all-reviews.js (auto-clear of stale showNotMentioned)
 *   - scripts/collect-review-texts.js (write-path quarantine)
 *   - scripts/audit-llm-hallucinations.js (corpus sweep)
 *
 * @param {Object} show - shows.json entry for the show this review belongs to
 * @param {string} text - Text to validate (fullText or wrongFullText)
 * @param {Object} cv - contentVerification object from the review file
 * @returns {null | { passed: boolean, matchedKeyword: string|null, keywordsChecked: string[] }}
 */
function checkLlmVerificationAgainstKeywords(show, text, cv) {
  if (!cv || typeof cv.verifiedBy !== 'string' || !cv.verifiedBy.startsWith('llm:')) return null;
  if (cv.isValid !== true) return null;
  if (cv.wrongArticle === true) return null;
  if (!text || typeof text !== 'string' || text.length < 100) return null;
  const keywords = buildShowKeywordSet(show);
  if (keywords.size === 0) return null;
  const matched = findShowKeywordInText(text, keywords);
  return {
    passed: matched !== null,
    matchedKeyword: matched,
    keywordsChecked: Array.from(keywords),
  };
}

// ---------------------------------------------------------------------------
// SERP retry guard — splits by incompleteReason
// ---------------------------------------------------------------------------
//
// Empirical context (2026-04-11): 13,905 review files are stuck with
// incompleteReason in {no_url, wrong_content, fabricatedEntry}. 13,483 are
// `wrong_content` — a URL was found but content verification rejected it.
// Re-SERPing these with the same deterministic query (site:outlet + title +
// year window) returns the same wrong URL (url-discovery.js:533 skips the
// current URL and picks sibling pages). 83% are on shows closed >180 days
// ago where the SERP date window is frozen.
//
// Strategy:
//   - `no_url` (422 files): timestamp-based cooldown via serpRetryAfter
//   - `wrong_content` (13,483 files): hard retry cap via serpRetryCount +
//     serpDiscoveryAbandoned. Closed-old (>180d) gets 0 retries — once a file
//     with a frozen SERP window is known bad, it's always bad.
//
// The guard is PURE: query functions (shouldRetryUrlDiscovery) decide whether
// to SERP, compute functions (recordSerpAttempt) return the new state the
// caller must write to the review file. All I/O happens in the caller.
//
// New protected fields on review files (synced in review-write-guard.js +
// push-review-texts action.yml PROTECTED list):
//   - serpRetryAfter (ISO timestamp — don't SERP before this)
//   - serpRetryCount (int — cumulative SERP attempts for this file)
//   - serpDiscoveryAbandoned (bool — permanent gate, only cleared manually)
//
// See: sprint-plan-serp-cost-reduction.md, /second-opinion review

const DAY_MS = 86400000;

// urlDiscoveryMethod values that represent a REAL SERP call. Other methods
// like 'protocol-upgrade' (HTTP→HTTPS), 'http-redirect', and 'domain-redirect'
// are routine URL normalizations that don't prove SERP cycle pathology and
// shouldn't count as evidence of a SERP attempt. Keep in sync with
// scripts/lib/url-discovery.js writers and SERP-writing paths in
// collect-review-texts.js. Consumed by backfill-serp-abandonment.js and
// unabandon-non-serp-cycles.js.
const SERP_DISCOVERY_METHODS = Object.freeze(new Set([
  'google-serp',
  'google-serp-reason-recovery',
  'show-not-mentioned-recovery',
  'wrongUrl-serp-retry',
]));

// Max SERP retries for `wrong_content` reviews keyed by show lifecycle.
// closedOld = 0 because the SERP window is frozen and retries are futile.
// openWindow = 3 because outlet content is still churning during the
// 14-day (BW) / 21-day (WE/OB) opening window and new URLs may be indexed.
const MAX_RETRIES_WRONG_CONTENT = Object.freeze({
  previews: 2,
  openWindow: 3,
  openRecent: 1,
  openMature: 1,
  closedRecent: 1,
  closedOld: 0,
  unknown: 1,
});

// Cooldown between SERP attempts (for `no_url` and for `wrong_content` while
// still under MAX_RETRIES). Short during opening windows (hourly poller needs
// fresh signal), long for closed shows (SERP results frozen).
const COOLDOWN_MS = Object.freeze({
  previews: 24 * 3600 * 1000,     // 24h
  openWindow: 12 * 3600 * 1000,   // 12h
  openRecent: 3 * DAY_MS,          // 3 days
  openMature: 14 * DAY_MS,         // 14 days
  closedRecent: 30 * DAY_MS,       // 30 days
  closedOld: 90 * DAY_MS,          // 90 days
  unknown: 7 * DAY_MS,             // 7 days (safe default)
});

/**
 * Classify a show into a lifecycle bucket for SERP retry decisions.
 *
 * Buckets:
 *   - 'previews'     — status=='previews' OR openingDate is in the future
 *   - 'openWindow'   — open, within 14d (BW) / 21d (WE/OB/OWE) of opening
 *   - 'openRecent'   — open, within 90d of opening
 *   - 'openMature'   — open, >90d since opening
 *   - 'closedRecent' — closed ≤180 days ago
 *   - 'closedOld'    — closed >180 days ago
 *   - 'unknown'      — missing status/openingDate/closingDate (safe default)
 *
 * @param {Object|null} show - shows.json entry
 * @returns {'previews'|'openWindow'|'openRecent'|'openMature'|'closedRecent'|'closedOld'|'unknown'}
 */
function classifyLifecycle(show) {
  if (!show || typeof show !== 'object') return 'unknown';
  const status = show.status || 'unknown';
  const now = Date.now();

  if (status === 'closed') {
    if (!show.closingDate) return 'unknown';
    const closedMs = new Date(show.closingDate).getTime();
    if (isNaN(closedMs)) return 'unknown';
    const daysClosed = (now - closedMs) / DAY_MS;
    return daysClosed > 180 ? 'closedOld' : 'closedRecent';
  }

  if (status === 'previews') return 'previews';

  // open / unknown-but-has-opening
  if (!show.openingDate) return 'unknown';
  const openedMs = new Date(show.openingDate).getTime();
  if (isNaN(openedMs)) return 'unknown';
  const daysOpen = (now - openedMs) / DAY_MS;

  if (daysOpen < 0) return 'previews'; // opening date in future ⇒ still previews
  const category = show.category || '';
  const isWEorOB = category === 'west-end' || category === 'off-west-end' || category === 'off-broadway';
  const openWindowDays = isWEorOB ? 21 : 14;
  if (daysOpen <= openWindowDays) return 'openWindow';
  if (daysOpen <= 90) return 'openRecent';
  return 'openMature';
}

/**
 * Decide whether a review should be re-SERPed for URL discovery.
 *
 * Returns { shouldRetry, reason, nextAttemptAt?, updates? }. The `updates`
 * field is a state patch the caller MUST write to the review file even when
 * shouldRetry is false — specifically when we just crossed the max-retries
 * threshold and need to record serpDiscoveryAbandoned so the next run
 * short-circuits without re-evaluating.
 *
 * Reasons the gate can return:
 *   - 'not_gated'           — incompleteReason is not no_url/wrong_content/fabricated, allow retry
 *   - 'abandoned'           — serpDiscoveryAbandoned is already true, never retry
 *   - 'max_retries_reached' — just hit max; caller should apply updates and skip
 *   - 'cooldown'            — serpRetryAfter is in the future, skip until then
 *   - 'no_url_retry'        — proceed with SERP
 *   - 'wrong_content_retry' — proceed with SERP (still under max, cooldown elapsed)
 *
 * @param {Object|null} show - shows.json entry
 * @param {Object} review - Review data object
 * @returns {{ shouldRetry: boolean, reason: string, nextAttemptAt?: string, updates?: Object }}
 */
function shouldRetryUrlDiscovery(show, review) {
  if (!review || typeof review !== 'object') return { shouldRetry: true, reason: 'not_gated' };

  const ir = review.incompleteReason;
  const isNoUrl = ir === 'no_url';
  const isWrongContent = ir === 'wrong_content';
  const isFabricated = !!review.fabricatedEntry;

  // Not in a gated state → let callers proceed (e.g. collector-flagged
  // wrongShow retries via existing wrongShowRetryAt path are not this gate's
  // responsibility).
  if (!isNoUrl && !isWrongContent && !isFabricated) {
    return { shouldRetry: true, reason: 'not_gated' };
  }

  // Permanent gate — once set, only a human unsets.
  if (review.serpDiscoveryAbandoned === true) {
    return { shouldRetry: false, reason: 'abandoned' };
  }

  const lifecycle = classifyLifecycle(show);
  const count = typeof review.serpRetryCount === 'number' ? review.serpRetryCount : 0;

  // wrong_content: hard retry cap
  if (isWrongContent) {
    const max = MAX_RETRIES_WRONG_CONTENT[lifecycle] ?? 1;
    if (count >= max) {
      return {
        shouldRetry: false,
        reason: 'max_retries_reached',
        updates: { serpDiscoveryAbandoned: true },
      };
    }
  }

  // Cooldown gate (applies to both no_url and wrong_content under max)
  if (review.serpRetryAfter) {
    const after = new Date(review.serpRetryAfter).getTime();
    if (!isNaN(after) && Date.now() < after) {
      return {
        shouldRetry: false,
        reason: 'cooldown',
        nextAttemptAt: review.serpRetryAfter,
      };
    }
  }

  // Allow retry — tag reason for logging
  if (isWrongContent) return { shouldRetry: true, reason: 'wrong_content_retry' };
  return { shouldRetry: true, reason: isFabricated ? 'fabricated_retry' : 'no_url_retry' };
}

/**
 * Compute the state updates to apply to a review file AFTER a SERP attempt.
 *
 * Call this whether the SERP call succeeded or failed — the retry count and
 * cooldown must advance either way, or a perpetually-null SERP response
 * would never trigger abandonment.
 *
 * Returns { serpRetryCount, serpRetryAfter?, serpDiscoveryAbandoned? } — a
 * patch the caller merges into the review file before writing.
 *
 * @param {Object|null} show - shows.json entry
 * @param {Object} review - Review data object (pre-update)
 * @returns {Object} Patch to apply
 */
function recordSerpAttempt(show, review) {
  if (!review || typeof review !== 'object') return {};

  const ir = review.incompleteReason;
  const isNoUrl = ir === 'no_url' || !!review.fabricatedEntry;
  const isWrongContent = ir === 'wrong_content';
  if (!isNoUrl && !isWrongContent) return {};

  const prevCount = typeof review.serpRetryCount === 'number' ? review.serpRetryCount : 0;
  const newCount = prevCount + 1;
  const updates = { serpRetryCount: newCount };

  const lifecycle = classifyLifecycle(show);

  // wrong_content: check if this attempt just hit the cap → abandon
  if (isWrongContent) {
    const max = MAX_RETRIES_WRONG_CONTENT[lifecycle] ?? 1;
    if (newCount >= max) {
      updates.serpDiscoveryAbandoned = true;
      return updates;
    }
  }

  // Still have retries → set next cooldown
  const cooldown = COOLDOWN_MS[lifecycle] ?? (7 * DAY_MS);
  updates.serpRetryAfter = new Date(Date.now() + cooldown).toISOString();

  return updates;
}

/**
 * Cross-production reroute decision (URL-year guard).
 *
 * Given the show year of the current directory and a list of sibling productions
 * (same title, same market, different show ID), and a year detected from the
 * review's publishDate or URL, decide whether to keep the review in the current
 * directory or reroute it to a sibling whose year is closer.
 *
 * Replaces the previous "drop on mismatch" behavior at scripts/rebuild-all-reviews.js
 * (URL-year cross-production guard) — instead of losing legitimate reviews filed
 * under the wrong sibling, we hand them to the correct one.
 *
 * Decision rules:
 *   - If detectedYear falls inside currentShowRunWindow [startYear, endYear] → keep.
 *     Prevents mid-run reviews of long-running shows from being misrouted to a
 *     revival just because the revival's year is numerically closer. E.g., a 2014
 *     NYT review of mamma-mia-2001 (which ran 2001–2015) must NOT route to
 *     mamma-mia-2025 because 2014 is dist-11 from 2025 vs dist-13 from 2001.
 *   - If detectedYear is within 1 year of currentShowYear → keep (not a mismatch).
 *   - Otherwise pick the sibling with the SMALLEST distance to detectedYear.
 *   - That distance must be strictly less than the distance to the current show.
 *   - Tiebreak between equidistant siblings: prefer the more RECENT year (newer
 *     productions are more likely to be the live target of aggregator scrapers).
 *   - If no sibling beats the current distance, keep.
 *
 * @param {number} currentShowYear - Opening year of the show whose directory holds the file
 * @param {Array<{id: string, year: number}>} siblings - Other productions in the same market
 * @param {number|null} detectedYear - Year extracted from publishDate or URL (null = no signal)
 * @param {[number, number]|null|undefined} [currentShowRunWindow] - Inclusive [startYear, endYear]
 *   of the current show's active run. If omitted, behaves exactly as before (backward compat).
 * @returns {{action: 'keep'} | {action: 'reroute', targetShowId: string, targetYear: number, distance: number}}
 */
function pickRerouteTarget(currentShowYear, siblings, detectedYear, currentShowRunWindow) {
  if (!detectedYear || !currentShowYear || !siblings || siblings.length === 0) {
    return { action: 'keep' };
  }
  // Run-window guard: if detectedYear is inside the current show's active run,
  // the review belongs here regardless of sibling distance.
  if (Array.isArray(currentShowRunWindow) && currentShowRunWindow.length === 2) {
    const [startYear, endYear] = currentShowRunWindow;
    if (Number.isFinite(startYear) && Number.isFinite(endYear)
        && detectedYear >= startYear && detectedYear <= endYear) {
      return { action: 'keep' };
    }
  }
  const distToCurrent = Math.abs(detectedYear - currentShowYear);
  if (distToCurrent <= 1) return { action: 'keep' };

  let best = null;
  for (const sib of siblings) {
    if (!sib || !sib.year || !sib.id) continue;
    const dist = Math.abs(detectedYear - sib.year);
    if (dist >= distToCurrent) continue; // not closer than current
    if (
      best === null ||
      dist < best.distance ||
      (dist === best.distance && sib.year > best.targetYear)
    ) {
      best = { targetShowId: sib.id, targetYear: sib.year, distance: dist };
    }
  }
  if (!best) return { action: 'keep' };
  return { action: 'reroute', ...best };
}

/**
 * Build the multi-production year guard map from shows data.
 * Groups shows by normalized title, then for each show with siblings in the
 * same market, records { showYear, siblings: [{ id, year }] }.
 *
 * Broadway and off-broadway are treated as one NYC market.
 * West End is a separate market — never cross-compared with Broadway/OB.
 *
 * @param {Array<Object>} shows - Array of show objects from shows.json
 * @returns {Object} Map of showId → { showYear, siblings }
 */
function buildMultiProdYearGuard(shows) {
  const titleGroups = {};
  for (const s of shows) {
    const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!titleGroups[normTitle]) titleGroups[normTitle] = [];
    titleGroups[normTitle].push(s);
  }
  const guard = {};
  for (const [, prods] of Object.entries(titleGroups)) {
    if (prods.length < 2) continue;
    for (const show of prods) {
      const showYear = show.openingDate ? parseInt(show.openingDate.slice(0, 4))
        : show.previewsStartDate ? parseInt(show.previewsStartDate.slice(0, 4)) : null;
      if (!showYear) continue;
      const showCat = show.category || 'broadway';
      const nycMarket = showCat === 'broadway' || showCat === 'off-broadway';
      const siblings = prods.filter(p => {
        if (p.id === show.id) return false;
        const pCat = p.category || 'broadway';
        if (nycMarket) return pCat === 'broadway' || pCat === 'off-broadway';
        return pCat === showCat;
      }).map(p => ({
        id: p.id,
        year: p.openingDate ? parseInt(p.openingDate.slice(0, 4))
          : p.previewsStartDate ? parseInt(p.previewsStartDate.slice(0, 4)) : null,
      })).filter(p => p.year);
      if (siblings.length > 0) guard[show.id] = { showYear, siblings };
    }
  }
  return guard;
}

/**
 * Returns true if rebuild-all-reviews.js would include this review in reviews.json.
 * Mirrors the pure-flag exclusion conditions from rebuild-all-reviews.js.
 *
 * Known limitations (context-dependent guards not expressible as pure predicates):
 *   - showNotMentioned: rebuild has complex auto-clear logic (text scan + LLM CV)
 *   - cross-market guard: needs show category + outlet registry
 *   - pre-opening date guard: needs show's earliest date
 *   - runtime syndication dedup: needs allJsonFiles for the show
 *   - LLM reasoning keywords: needs llmScore.reasoning string evaluation
 * These cause countLocalIncluded to over-count by ~3-5 per show on average.
 *
 * Intentionally NOT excluded: duplicateTextOf — rebuild keeps those when the
 * referenced entry is also excluded; mirroring that precisely requires context
 * this predicate doesn't have.
 */
function isIncludableForRebuild(data, show, filePath) {
  if (!data) return false;

  // S3-T6: CV-promotion-deferred reviews are explicitly includable.
  //
  // The defer mechanism (S3-T5, scripts/rebuild-all-reviews.js) sets
  // `flaggedForReview=true` + `flagReason='cv-promotion-deferred'` when the
  // LLM-CV pass would otherwise promote a long-biographical-lead review to
  // `wrongShow=true`. The defer prevents that silent rejection at outlets
  // whose house style legitimately opens with biographical framing
  // (`cvStyle: 'biographical-lead'` in outlet-registry.json).
  //
  // These reviews must continue to appear in reviews.json AND be scored
  // normally — the defer is about NOT being silently wrongShow'd, not about
  // exclusion. We intentionally do not gate this on outletId or anything
  // else; the specific `flagReason` value is sufficient (it is set only by
  // the S3-T5 deferral logic in rebuild-all-reviews.js, search
  // "cv-promotion-deferred").
  //
  // No `return true` here — that would override other legitimate exclusion
  // rules (e.g. a separately-set wrongProduction). Instead, this comment
  // documents the contract so a future contributor doesn't accidentally
  // reject these reviews via a generic `flaggedForReview === true` check.
  // The existing rules below already do the right thing because none of
  // them gate on `flaggedForReview` or this specific `flagReason`.
  //
  // Cross-ref: memory/feedback_includability_predicates_must_be_canonical.md
  // (every flag lives in the central guard).

  // wrongProduction — excluded unless cleared by one of three override flags
  if (data.wrongProduction === true) {
    const cleared =
      data.wrongProductionManualClear === true ||
      data.wrongProductionOverride === true ||
      data.humanReviewedWrongProduction === false;
    if (!cleared) return false;
  }

  // wrongShow — manual clears via wrongShowCleared() (5-flag check, single
  // source of truth shared with the other gates). If a human has verified the
  // correct production, that also means the correct show — the LLM ensemble's
  // wrong_show rejection for Giant (Mark Rosenblatt play vs musical) on
  // 2026-04-22 is exactly this case: LLM knew "Giant the musical" from
  // training and mis-identified the Broadway play as the wrong show.
  //
  // Stale-flag override (Notion 34e637c5-416f-8121): when no manual clear is
  // set but the data + URL signals strongly indicate a real review of THIS
  // show, isLikelyStaleWrongShow defers to the rebuild. Conservative — see
  // helper docstring for the full filter chain.
  if (data.wrongShow === true) {
    if (!wrongShowCleared(data) && !isLikelyStaleWrongShow(data, show)) return false;
  }
  if (data.wrongAttribution === true) return false;
  // duplicateOf: when filePath is provided, mirror rebuild-all-reviews.js's
  // circular-duplicate-recovery logic (BUG F / Heated Rivalry nyt-theater--*
  // pair, 2026-05-27). The rebuild keeps the lexically-LOWER filename when
  // two files mutually point at each other with the same fullText fingerprint;
  // pre-fix the LLM scorer skipped both, leaving the kept file unscored and
  // absent from reviews.json. When filePath is undefined we fall back to the
  // historical "skip on any duplicateOf" behavior — recovery is opt-in.
  // Matching rebuild logic: scripts/rebuild-all-reviews.js ~lines 1685-1730.
  if (data.duplicateOf) {
    if (!filePath) return false;
    const pathMod = require('path');
    const fsMod = require('fs');
    const showDir = pathMod.dirname(filePath);
    const thisFile = pathMod.basename(filePath);
    const refPath = pathMod.join(showDir, data.duplicateOf);
    let refData = null;
    try {
      refData = JSON.parse(fsMod.readFileSync(refPath, 'utf8'));
    } catch {
      // Stale pointer — rebuild keeps this file in that case (refAlsoDupe=true
      // branch on read failure means we drop out of the skip path).
      // Don't return — fall through to the remaining guards below.
      refData = undefined;
    }
    if (refData !== undefined) {
      const refDupOf = refData && (refData.duplicateOf || refData.duplicateTextOf);
      const isCircular = refDupOf === thisFile;
      if (isCircular && data.fullText && refData.fullText) {
        const { computeContentFingerprint } = require('./content-quality');
        const a = computeContentFingerprint(data.fullText);
        const b = computeContentFingerprint(refData.fullText);
        const circularSameText = !!(a && b && a === b);
        if (circularSameText) {
          // Tiebreak: keep lexicographically-LOWER filename. Matches rebuild's
          // `file > data.duplicateOf` skip condition (we skip when greater).
          if (thisFile > data.duplicateOf) return false;
          // else: lexically lower → ALLOW (fall through to remaining guards).
        } else {
          // Circular with DIFFERENT text — rebuild treats these as legitimate
          // separate reviews (duplicateOf wrongly set). Both sides kept.
          // Fall through.
        }
      } else if (refDupOf) {
        // Reference also a dupe but pointing elsewhere (not back at us) —
        // rebuild's `refAlsoDupe` branch lets this through. Fall through.
      } else {
        // Reference exists and is NOT also flagged → legitimate dup, skip.
        return false;
      }
    }
  }
  if (data.isRoundupArticle === true && !isLikelyStaleRoundupFlag(data)) return false;
  // Unflagged roundup pages (flag setter is enrichment-gated; parity with rebuild's
  // inclusion gate so scoring never scores what rebuild excludes — ship-check 2026-07-10)
  if (isRoundupPageAsReview(data)) return false;
  // Blocked review URLs (google redirect wrappers, ticket pages, aggregator/roundup
  // domains, social media). Rebuild has auto-rejected these since the gather-time
  // guard was added (rebuild-all-reviews.js "skippedBlockedUrl" — rebuild does NOT
  // delegate its main flow to this predicate, so its inline check stays as the
  // enforcement). This mirror keeps external callers in parity: without it,
  // check-review-count-drift counted blocklist-dropped files as "suppressed"
  // forever, and those false suppressions padded the JCS broadcast-block warnings
  // (2026-07-09, Notion 39a637c5-416f-813a). Canonical-guard rule:
  // memory/feedback_includability_predicates_must_be_canonical.md.
  if (data.url && require('./domain-filters').isBlockedReviewUrl(data.url)) return false;
  if (
    data.isNonReview === true ||
    data.isNotReview === true ||
    data.nonReviewFlag === true ||
    data.nonReviewContent === true
  ) return false;
  if (data.fabricatedEntry === true) return false;
  if (data.isSyndicatedDuplicate === true) return false;
  if (data.crossOutletDuplicate === true) return false;
  // BWW aggregator ambiguity: review was extracted from BWW's /reviews/ page for a show
  // that has title-token-overlap siblings (e.g. "Cats" reviews landing on a
  // "CATS: The Jellicle Ball" page) with no date or URL-year to disambiguate.
  // Excluded until manually cleared via bwwAggregatorAmbiguousClearedNote.
  if (data.bwwAggregatorAmbiguous === true && !data.bwwAggregatorAmbiguousClearedNote) return false;
  // suspectedMisattribution: stale-flag override mirrors wrongShow's pattern at
  // line 1726. Pre-2026-04-29 only is-scoreable.ts honored isLikelyStale*; rebuild
  // unconditionally blocked, which made the LLM/rebuild parity refactor (Notion
  // 34f637c5-416f-810d) lose the override on delegation. Adding it here keeps both
  // predicates symmetric and preserves the registry-aware behavior.
  if (data.suspectedMisattribution === true && !isLikelyStaleSuspectedMisattribution(data, getCriticRegistry())) return false;
  if (
    data.contentVerification?.wrongArticle === true &&
    data.contentVerification?.confidence === 'high'
  ) return false;

  // Garbage text or non-review content flagged by collection pipeline or LLM ensemble.
  // Exception: 'not_a_review' rejection fires on excerpt/promo text (ShowScore, LBO)
  // even when the outlet's JSON-LD schema records an explicit star rating. The json-ld
  // star IS the critic's published verdict — authoritative for KNOWN_STAR_OUTLETS. Allow
  // inclusion so the P0.5 path in getBestScore can use the structured-data score.
  if (data.rejectionReason) {
    const isJsonLdStarNotAReview = data.rejectionReason === 'not_a_review' &&
      (data.originalScoreSource === 'json-ld' || data.aggregatorStarsSource === 'json-ld') &&
      require('./score-extractors').KNOWN_STAR_OUTLETS.has(data.outletId);
    if (!isJsonLdStarNotAReview) return false;
  }
  if (data.rejectedBy && Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) return false;
  // Canonical exclusion signal: rejectedAt timestamp is set by llm-scoring when the ensemble
  // rejects a review (wrong_production, wrong_show, not_a_review, garbage_text). It is only
  // cleared by a re-scrape (collect-review-texts.js line 4247) or explicit manual reset.
  // Without this check, reviews whose rejectionReason was later cleared by clear-failure-flags
  // could slip back into reviews.json — which is what happened with the Vulture FILM review
  // of Hamlet (wrong_production) on 2026-04-20.
  // Exception 1: if text was re-scraped AFTER rejection, treat as revalidated and let downstream
  // scoring decide. collect-review-texts should have cleared rejectedAt in that case but
  // only does so when rejectionReason is still set, so this guard handles the leak.
  // Exception 2: if a human has manually cleared wrongProduction (wrongProductionManualClear,
  // humanReviewedWrongProduction===false, or wrongProductionOverride), the rejection is a
  // stale false positive and the guard must defer — same pattern as lines 1225-1230 and
  // 1289-1296 for other exclusion signals. Discovered 2026-04-22 when 4 audit B-class
  // false-positive clears stayed excluded (giant-2026, heart-wall-we, shedevil-we,
  // authenticator-we): LLM ensemble told "show context specifies Broadway" for WE shows
  // rejected them, and wrongProductionManualClear alone couldn't override the rejectedAt
  // guard. See Notion card 34b637c5-416f-81ff-a6d6-d453e7ed537c.
  if (data.rejectedAt && typeof data.rejectedAt === 'string') {
    const reFetched = data.textFetchedAt && typeof data.textFetchedAt === 'string' && data.textFetchedAt > data.rejectedAt;
    const wpCleared =
      data.wrongProductionManualClear === true ||
      data.wrongProductionOverride === true ||
      data.humanReviewedWrongProduction === false;
    // Exception 3: matches the rejectionReason exception above — not_a_review + json-ld star
    // from a known star outlet clears the rejectedAt gate as well.
    const isJsonLdStarNotAReview = data.rejectionReason === 'not_a_review' &&
      (data.originalScoreSource === 'json-ld' || data.aggregatorStarsSource === 'json-ld') &&
      require('./score-extractors').KNOWN_STAR_OUTLETS.has(data.outletId);
    if (!reFetched && !wpCleared && !isJsonLdStarNotAReview) return false;
  }

  // Stale wrong-content flag: rebuild's drift-checker excludes this at line 3158.
  // Clear condition: wrongShow + wrongProduction are both gone AND text is substantial.
  // Only exclude if the stale flag is still legitimate (wrong flags not cleared yet).
  if (data.incompleteReason === 'wrong_content') {
    // Respect manual clears for wrongProduction (mirrors the check above at line 1072)
    const wpCleared =
      data.wrongProductionManualClear === true ||
      data.wrongProductionOverride === true ||
      data.humanReviewedWrongProduction === false;
    const wpBlocking = data.wrongProduction === true && !wpCleared;
    if (data.wrongShow || wpBlocking) return false;
    // If no substantial text, also correct to exclude
    const hasText = !!(data.fullText && data.fullText.trim().length >= 200);
    const hasSignal = !!(data.aggregatorStars != null || data.originalScore != null || data.llmScore);
    if (!hasText && !hasSignal) return false;
  }

  // Invalid content tier: rebuild's drift-checker excludes this at line 3158.
  // Respect manual clears — if wrongProduction was the reason and has since been cleared,
  // the contentTier=invalid flag is stale and should not block inclusion.
  if (data.contentTier === 'invalid') {
    const wpCleared =
      data.wrongProductionManualClear === true ||
      data.wrongProductionOverride === true ||
      data.humanReviewedWrongProduction === false;
    if (!wpCleared) return false;
    // Cleared — fall through and let text/signal check decide
  }

  // fullTextWrongAuthor: rebuild deletes fullText in memory and falls back to excerpts only.
  // On disk the fullText still exists, so we must check excerpt fields directly.
  if (data.fullTextWrongAuthor === true) {
    const hasExcerpt = !!(
      data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt ||
      data.nycTheatreExcerpt || data.lboRoundupExcerpt || data.stagedoorExcerpt
    );
    if (!hasExcerpt) return false;
    // Has excerpt — fall through to final text/agg check (excerpts count as content)
    return true;
  }

  // Must have either review text or an aggregator signal
  const hasText = !!(data.fullText && data.fullText.trim());
  const hasAggregatorSignal = !!(
    data.aggregatorStars ||
    data.originalScore != null ||
    data.llmScore
  );
  if (!hasText && !hasAggregatorSignal) return false;

  return true;
}

/**
 * Pattern Card #4 (gather-reviews.js) — Pending-strand routing decision.
 *
 * `createReviewFile()` routes byline-less reviews (criticName="Unknown") with a URL
 * to data/review-texts/_pending/ to avoid duplicating already-ingested named-critic
 * reviews. The carve-out: trusted/verified discovery sources bypass the pending strand
 * so collect-review-texts.js AUTHOR ENRICHMENT can resolve the byline from page HTML.
 *
 * Explicit allowlist (rather than a prefix match) so a new helper emitting a
 * 'direct-urlsomething' / 'direct-url-unverified' source doesn't silently gain the
 * bypass without a deliberate code change here. Any new trusted source must be
 * added explicitly — tests/unit/pending-strand-routing.test.mjs asserts the set.
 *
 * Current members:
 *   - 'serp-discovery' — SERP hit at a multi-critic outlet (NYT, NYSR, Vulture, Theatrely).
 *     Original carve-out per Express coverage-gap fix #4 (commit f7005e28c3).
 *   - 'direct-url-construction' / 'direct-url-index-fallback' / 'direct-url-override' —
 *     Helper-verified direct URLs from scripts/lib/tb-direct-url.js. The helper gates
 *     on title match + byline-or-verdict signal + date window, so the URL is trustworthy
 *     even when the author-extraction regex can't recover a byline from the page HTML.
 *     Added 2026-04-22 after Schmigadoon TB review was stranded by the original
 *     carve-out's serp-only check.
 *
 * @param {string|undefined} source - The review.source field (case-sensitive contract)
 * @returns {boolean}
 */
const VERIFIED_DISCOVERY_SOURCES = new Set([
  'serp-discovery',
  'direct-url-construction',
  'direct-url-index-fallback',
  'direct-url-override',
]);

function isVerifiedDiscoverySource(source) {
  if (typeof source !== 'string' || !source) return false;
  return VERIFIED_DISCOVERY_SOURCES.has(source);
}

/**
 * Pattern Card #4 — full routing decision for byline-less reviews.
 *
 * @param {Object} review - { criticName, url, source }
 * @returns {boolean} true if the review should be written to _pending/ instead of
 *   the main show directory.
 */
/**
 * Balusters postmortem Class #1 — CV/LLM contradiction check.
 *
 * If the LLM ensemble scored this file with a confident numeric score, it evaluated
 * the article as a review. If CV later flags wrongArticle=true, that's a contradiction
 * — either the ensemble was fooled or CV is wrong. The ensemble has more signal
 * (reads full text, outputs structured score + bucket + reasoning) than CV (2-3 opening
 * paragraphs, classifies type). Prefer the ensemble.
 *
 * Balusters 2026-04-21: Helen Shaw (NYT Critic's Pick, ensemble=80 high-conf) and
 * Ron Fassler (Theater Pizzazz rave, ensemble=88 high-conf) were both CV-flagged
 * wrongArticle=true because they open with historical framing. Without manual
 * intervention they would have been excluded from reviews.json.
 *
 * @param {Object} data - Review data
 * @returns {boolean} true if ensemble gave this a confident score — CV.wrongArticle should be advisory
 */
function hasHighConfidenceLlmScore(data) {
  const llm = data && data.llmScore;
  if (!llm) return false;
  if (!Number.isFinite(llm.score)) return false;
  const conf = String(llm.confidence || '').toLowerCase();
  return conf === 'high' || conf === 'medium';
}

/**
 * Skip predicate for score-reviews-llm.js.
 *
 * Returns true when the review file already has a real numeric assignedScore
 * (any number, including 0 for an extreme Pan) and therefore should NOT be
 * re-scored.
 *
 * Why typeof, not !== null:
 *   - `!== null` skips undefined (the bug) — newly-created files have no field
 *     at all, so they were silently skipped without being scored.
 *   - `!= null` would over-correct: it permits 0 (a valid Pan) to be re-scored
 *     every run because 0 == null is false but 0 is still a valid score.
 *   - `typeof === 'number'` correctly skips any numeric score (including 0)
 *     while still processing files where the field is undefined or null.
 *
 * @param {Object} review - Parsed review-texts JSON file content
 * @returns {boolean} True if the file already has a numeric assignedScore
 */
function isAlreadyLlmScored(review) {
  return typeof review.assignedScore === 'number';
}

function shouldRouteUnknownCriticToPending(review) {
  if (!review || typeof review !== 'object') return false;
  const isUnknownCritic = (review.criticName || '').toString().toLowerCase().trim() === 'unknown';
  if (!isUnknownCritic) return false;
  if (!review.url) return false;
  return !isVerifiedDiscoverySource(review.source);
}

/**
 * Tracking / analytics / auth query params that MUST be stripped before
 * comparing two URLs for duplicate-review dedup. These never identify an
 * article — they identify a click, a mailing, or a redirect chain.
 *
 * Rocky Horror 2026-04-23: Cote Notices David Cote (no param) and BWW-RR-extracted
 * David Finkle (?triedRedirect=true) pointed at the same Substack article but
 * the dedup compared full URLs and saw two distinct keys. Both shipped live.
 *
 * Exact names match. Wildcard prefixes (utm_*, mc_*) via `startsWith`. Keep
 * this list conservative: removing a legitimate article-ID param silently
 * collapses two distinct reviews into one.
 */
const TRACKING_PARAM_NAMES = new Set([
  'triedredirect',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'refsrc',
  'source',
  'src',
  '_hsenc',
  '_hsmi',
  '_openstat',
  'trk',
  'si',
  's_cid',
  'share',
  'shared',
  'sharedfrom',
  // Substack / newsletter tracking
  '_bhlid',
  'publication_id',
  'post_id',
  // Branch / deep-link
  '_branch_match_id',
  '_branch_referrer',
  // Facebook + CMS misc
  'wt_zmc',
  'xid',
  // Google News referrer params (seen in WSJ/NYT indexing)
  'searchresultposition',
  'gaa_at',
  'gaa_n',
  'gaa_ts',
  'gaa_sig',
  // Legacy NYT tracking (every NYT URL before ~2014 had some of these)
  'smid',
  'smtyp',
  'pagewanted',
  '_r',
  'adxnnl',
  'adxnnlx',
  'gwh',
  'gwt',
  // WaPo
  'wpisrc',
  'wpmm',
  'wpmk',
  // Other common article-source trackers
  'partner',
  'emc',
  'nc',
  'algo',
  'impression_id',
  // Google Merchant / Shopping "Search Results Source Landing Tracking ID" —
  // appended to organic links from Google surfaces. Always a tracking value,
  // never an article identifier. Seen on 196 review files; without stripping it,
  // ew.com/.../review/?srsltid=X and ew.com/.../review/ canonicalize differently
  // and the same review double-counts (aint-too-proud EW, 2026-06-01).
  'srsltid',
]);
const TRACKING_PARAM_PREFIXES = ['utm_', 'mc_', 'pk_', 'hsa_', 'mtm_'];

function _isTrackingParam(name) {
  const n = (name || '').toLowerCase();
  if (TRACKING_PARAM_NAMES.has(n)) return true;
  return TRACKING_PARAM_PREFIXES.some(p => n.startsWith(p));
}

/**
 * Canonicalize a URL for duplicate detection. Lowercases the hostname, strips
 * the fragment, removes tracking-only query params, and strips the trailing
 * slash. Preserves non-tracking query params because some outlets (older PHP
 * CMS sites, WP with ?p= or ?article_id=) use them as article identifiers.
 *
 * Use this anywhere two review URLs are being compared for "same article":
 *   - rebuild-all-reviews.js seenUrlsByOutlet / seenUrlsGlobal
 *   - gather-reviews.js seenUrlsForOutlet
 *   - multi-critic-serp.js
 *   - llm-extractor.js mergeAggregatorReviews
 *
 * Contract: never throw. Falls back to a lowercased trimmed string on parse
 * failure so pipeline doesn't halt on a malformed URL.
 *
 * @param {string|null|undefined} url
 * @returns {string} canonical form; empty string if input is unusable
 */
function canonicalizeUrlForDedup(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    // Collect + sort non-tracking params so param-order-only differences
    // collapse to the same key. e.g., `?a=1&b=2` and `?b=2&a=1` canonicalize
    // to identical strings. Without sorting, SERP results that reorder params
    // would dedup as distinct.
    const kept = [];
    for (const [k, v] of u.searchParams) {
      if (!_isTrackingParam(k)) kept.push([k, v]);
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    // Rebuild searchParams in sorted order.
    const sp = new URLSearchParams();
    for (const [k, v] of kept) sp.append(k, v);
    u.search = sp.toString() ? `?${sp.toString()}` : '';
    let s = u.toString().toLowerCase();
    s = s.replace(/\/$/, '');
    return s;
  } catch {
    // Best-effort fallback for URLs the URL constructor can't parse.
    // Strip tracking params we can identify via regex — better than leaving
    // them on and having the malformed-URL path silently over-preserve tracking.
    let s = trimmed.toLowerCase().replace(/#.*$/, '');
    // Build a regex union of tracking param names (escaped) + known prefixes.
    const names = [...TRACKING_PARAM_NAMES].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const prefixes = TRACKING_PARAM_PREFIXES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z0-9_-]*').join('|');
    const trackingRe = new RegExp('([?&])(?:' + names + '|' + prefixes + ')=[^&]*', 'g');
    s = s.replace(trackingRe, (_, sep) => sep).replace(/\?&/g, '?').replace(/[?&]+$/, '').replace(/\/$/, '');
    return s;
  }
}

/**
 * Levenshtein edit distance — two strings, standard DP implementation.
 * Returns edit distance (substitution/insertion/deletion each cost 1).
 */
function _levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  const cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

const FUZZY_CRITIC_MIN_LENGTH = 6;
const FUZZY_CRITIC_MAX_EDIT_DISTANCE = 2;

/**
 * Decide whether two critic-name strings refer to the same person after a
 * typo-tolerant comparison. Returns true when the alphanumeric-normalized
 * strings differ by ≤2 edits AND both are ≥6 chars long (below that threshold
 * the risk of collapsing two distinct short surnames like "Li" / "Liu" is too
 * high). Returns false for exact matches — callers should short-circuit exact
 * matches first (cheaper + this is strictly about fuzzy recovery).
 *
 * Audit 2026-04-24 found 18 latent typo-duplicate pairs in live data that
 * Session 3's URL dedup + static CRITIC_CANONICAL_MAP didn't catch (e.g.,
 * Isabella Biedenahrn vs Biedenharn at EW, Marilyn vs Marylin Stasio at
 * Variety). See ~/Documents/claude-outputs/critic-typo-duplicates-2026-04-24.md.
 *
 * Used by the rebuild-all-reviews.js multi-critic-URL allow-through to
 * reject "two different named critics" when one is a typo of the other.
 *
 * @param {string} a  Raw critic name (any case, any whitespace)
 * @param {string} b  Raw critic name
 * @returns {boolean} true iff a ≈ b within Levenshtein ≤ 2 AND both ≥ 6 alnum chars
 */
function areSameCriticFuzzy(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!na || !nb) return false;
  if (na === nb) return false; // exact matches aren't fuzzy — callers handle separately
  if (Math.min(na.length, nb.length) < FUZZY_CRITIC_MIN_LENGTH) return false;
  // Quick skip: if lengths differ by more than the distance cap, can't match.
  if (Math.abs(na.length - nb.length) > FUZZY_CRITIC_MAX_EDIT_DISTANCE) return false;
  return _levenshtein(na, nb) <= FUZZY_CRITIC_MAX_EDIT_DISTANCE;
}

module.exports = {
  buildMultiProdYearGuard,
  shouldSkipScoredReview,
  pickBestDtliSlug,
  applyTemporalOverrides,
  isReviewWithinOwnProductionWindow,
  isSameTitleDifferentYearFalsePositive,
  applyVenueClassificationCarveout,
  isVenueClassificationObjection,
  showHasFestivalVenue,
  reasoningAssertsDifferentProduction,
  hasStrongDifferentShowSignal,
  hasNamedDifferentDirectorSignal,
  STRONG_DIFFERENT_SHOW_MARKERS,
  getWrongProductionReasonFromUrl,
  getWrongProductionReasonForUnknownCritic,
  urlYearFromPath,
  urlLooksLikeReview,
  isSluglessReviewUrl,
  isLikelyWrongProduction,
  isLikelyTourReview,
  isRoundupUrl,
  isLikelyStaleRoundupFlag,
  isLikelyStaleWrongShow,
  isLikelyStaleWrongProduction,
  isStaleCvPromotedWrongProduction,
  wrongShowCleared,
  isLikelyStaleSuspectedMisattribution,
  getCriticRegistry,
  _resetCriticRegistryCache,
  isVenueMismatch,
  isUrlTitleMismatch,
  shouldSkipWrongProductionAudit,
  shouldSkipCrossShowUrlFlag,
  isProductionAwareCvVerdict,
  shouldSkipRoundupAudit,
  isRoundupPageAsReview,
  isQuotingRoundupHostUrl,
  cvBlocksUkWrongProductionAutoClear,
  isRevivalByCanonicalTitle,
  urlOrTitleLooksLikeReview,
  isWrongShowUnknownLocked,
  evaluateShowMentionGuard,
  pickShowTitleForHeuristic,
  buildShowKeywordSet,
  findShowKeywordInText,
  checkLlmVerificationAgainstKeywords,
  classifyLifecycle,
  shouldRetryUrlDiscovery,
  recordSerpAttempt,
  pickRerouteTarget,
  isIncludableForRebuild,
  isVerifiedDiscoverySource,
  shouldRouteUnknownCriticToPending,
  hasHighConfidenceLlmScore,
  isAlreadyLlmScored,
  canonicalizeUrlForDedup,
  areSameCriticFuzzy,
  // Exported for test assertions
  MAX_RETRIES_WRONG_CONTENT,
  COOLDOWN_MS,
  TRACKING_PARAM_NAMES,
  TRACKING_PARAM_PREFIXES,
  FUZZY_CRITIC_MIN_LENGTH,
  FUZZY_CRITIC_MAX_EDIT_DISTANCE,
};
