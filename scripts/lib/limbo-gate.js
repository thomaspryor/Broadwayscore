'use strict';
/**
 * Limbo gate (BRO-7930). A review-text file is in LIMBO when it carries usable text, no exclusion flag, no
 * score, and no recorded routing decision. 2026-11-20: 313 such files (204 older than 14 days) for shows of
 * the last two years: NYT closing-soon lists, THR closing stories, WestEndTheatre roundups filed under another
 * outlet (27), and some real reviews whose text was site chrome. Rebuild silently dropped most of them at
 * runtime (explainExclusion), so nothing ever recorded WHY, and nothing told the scorer or a human.
 *
 * Contract: once a limbo file is older than GRACE_DAYS it is routed to exactly one of
 *   reject   rebuild excludes it (explainExclusion / not scoreable): the decision is recorded (limboRoute),
 *            and a WestEndTheatre roundup page filed under another outlet is flagged isRoundupArticle
 *   scoring  scorer's own selection will pick it up (scorerVerdict null) or it is in a cooldown that expires
 *   refetch  usable text is missing or is page chrome (no_scorable_text / terminal gate): needsRefetch
 * Pure classification; the CLI (scripts/route-limbo-reviews.js) applies it.
 */
const GRACE_DAYS = 7;
// 'complete' only: a truncated/excerpt/stub file already carries a pipeline-owned reason (incompleteReason) and
// a recovery route; limbo is the file that LOOKS finished but has no decision.
const SCOREABLE_TIERS = ['complete'];
const DECIDED_FLAGS = ['wrongProduction', 'wrongShow', 'isRoundupArticle', 'duplicateOf', 'wrongArticle', 'rejectedAt', 'excluded',
  'isNonReview', 'isNotReview', 'nonReviewFlag', 'rejectionReason', 'fabricatedEntry', 'isSyndicatedDuplicate', 'crossOutletDuplicate',
  'suspectedMisattribution', 'isPreview', 'notAReview', 'limboRoutedAt'];
const WET_OUTLETS = ['westendtheatre', 'west-end-theatre', 'west-end-theatre-editorial'];

const has = v => v !== null && v !== undefined && v !== '';

function isScored(d, guards) {
  return has(d.assignedScore) || !!d.llmScore || has(d.humanReviewScore) || guards.hasValidScore(d);
}

function ageDays(d, mtimeMs, nowMs) {
  const t = [d.firstSeenAt, d.textFetchedAt, d.collectedAt].map(v => (v ? Date.parse(v) : NaN)).find(Number.isFinite);
  const base = Number.isFinite(t) ? t : (mtimeMs || NaN);
  return Number.isFinite(base) ? (nowMs - base) / 864e5 : null;
}

const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Short / numeric titles ("44", "Job", "Oak", "Tru") fall under validateShowMentioned's exact-title floor (length > 3),
 * so real reviews of them carry showNotMentioned and the scorer skips them (44-off-broadway-2025: 5 reviews;
 * job-regional-2026: 5; oak-regional-2025: 6). Evidence that the text IS about the show: the title in quotes, or a
 * numeric title followed by a dash/"the musical". Case-sensitive on purpose ("The End" is not the show "End").
 */
function shortTitleEvidence(d, show) {
  const title = String((show && show.title) || '').trim();
  const text = typeof d.fullText === 'string' ? d.fullText : '';
  if (!title || !text || title.length > 4 || /\s/.test(title)) return false;
  const t = escRe(title);
  if (new RegExp(`[\u201c"\u2018'\u00ab]${t}[\u201d"\u2019'\u00bb]`).test(text)) return true;
  if (/^\d+$/.test(title) && new RegExp(`(?:^|[^\\d])${t}\\s*(?:[\u2014\u2013:\\-]|the musical\\b|musical\\b|play\\b)`, 'i').test(text)) return true;
  // The review's own URL names the show next to the word "review" (review-six-at-the-brooks-atkinson, oak-raven-theatre-review).
  let slug = '';
  try { slug = new URL(d.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return false; }
  const words = slug.toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[-_]+/);
  const at = words.indexOf(title.toLowerCase());
  if (at === -1) return false;
  // Adjacent to "review" (review-six-..., tru-review-...), and not a film/TV namesake ("review-six-film-...").
  const adj = words[at - 1] === 'review' || words[at + 1] === 'review' || (words[at - 1] === 'the' && words[at - 2] === 'review');
  const namesake = ['film', 'movie', 'series', 'tv', 'documentary'].includes(words[at + 1]);
  return adj && !namesake;
}

/**
 * A WestEndTheatre roundup page (a compiler's article quoting many outlets) filed under ANOTHER outlet, usually
 * with the compiler as critic (times-uk--ghenet-pinderhughes-randall): a fabricated outlet review. These carry the
 * roundup's star as aggregatorStars, so they look SCORED and never reach limbo; judged on the URL alone, with no
 * grace window. 27 unflagged on 2026-11-20. Returns a 'reject' decision (isRoundupArticle flag) or null.
 */
function misattributedWetRoundup(d, guards = require('./review-guards')) {
  if (!d || typeof d !== 'object') return null;
  if (DECIDED_FLAGS.some(k => !!d[k])) return null;
  const url = d.url || '';
  if (!/westendtheatre\.com/i.test(url) || WET_OUTLETS.includes(d.outletId)) return null;
  let isRoundup = false;
  try { isRoundup = !!guards.isRoundupUrl(url).isRoundup; } catch { /* not a roundup */ }
  return isRoundup
    ? { route: 'reject', rule: 'wet-roundup-misattributed', flag: { isRoundupArticle: true, roundupReason: 'WestEndTheatre.com roundup page filed under another outlet (BRO-7930)' } }
    : null;
}

/** True when this is a limbo CANDIDATE (before the grace window): usable text, no decision, no score. */
function isLimboCandidate(d, show, filePath, guards = require('./review-guards')) {
  if (!d || typeof d !== 'object') return false;
  if (!SCOREABLE_TIERS.includes(d.contentTier)) return false;
  // A previous 'show-not-mentioned' rejection or a 'refetch' route is re-judged each run: an improved rescue rule can
  // undo the first, and a refetch that recovered text moves to scoring.
  const reopen = (d.limboRoute === 'reject' && d.limboRule === 'show-not-mentioned') || d.limboRoute === 'refetch';
  if (DECIDED_FLAGS.some(k => !!d[k] && !(reopen && k === 'limboRoutedAt'))) return false;
  if (d.incompleteReason) return false; // owned by the recovery pipeline (url_content_mismatch, scraper_garbage, ...)
  return !isScored(d, guards);
}

/**
 * @returns {null | {route:'grace'|'reject'|'scoring'|'refetch', rule?:string, flag?:object}}
 *   null = not limbo (decided, scored, or no usable tier).
 */
function classifyLimbo(d, show, filePath, { nowMs = Date.now(), mtimeMs = 0, graceDays = GRACE_DAYS, guards, scoringQueue } = {}) {
  guards = guards || require('./review-guards');
  if (!isLimboCandidate(d, show, filePath, guards)) return null;
  const age = ageDays(d, mtimeMs, nowMs);
  if (age != null && age < graceDays) return { route: 'grace' };

  let excl = null;
  try { excl = guards.explainExclusion(d, show, filePath); } catch { excl = null; }
  if (excl) return { route: 'reject', rule: excl };
  scoringQueue = scoringQueue || require('./scoring-queue-counts');
  const isScoreable = require('./is-scoreable').isScoreable;
  if (!isScoreable(d, show, filePath)) {
    // A real review of a short-title show wrongly stamped showNotMentioned: clear the stamp, hand it to the scorer.
    if (d.showNotMentioned === true && shortTitleEvidence(d, show)) {
      let outside = false;
      try { outside = !!(d.publishDate && require('./date-guard').isArticleOutsideProductionWindow(show, d.publishDate)); } catch { /* no window info */ }
      const probe = { ...d }; delete probe.showNotMentioned;
      if (!outside && isScoreable(probe, show, filePath)) return { route: 'scoring', rule: 'short-title-evidence', clear: ['showNotMentioned', '_showNotMentionedDiscoveryAttempted'] };
    }
    return { route: 'reject', rule: d.showNotMentioned ? 'show-not-mentioned' : 'not-scoreable' };
  }
  const skip = scoringQueue.unscoredSkipReason(d, { show, showTitle: show && show.title, filePath });
  if (skip === null) return { route: 'scoring', rule: 'queued' };
  const S = scoringQueue.UNSCORED_SKIP;
  if (skip === S.NO_SCORABLE_TEXT || skip === S.TERMINAL_TEXT_GATE) return { route: 'refetch', rule: skip };
  if (skip === S.STICKY_REJECTION) return { route: 'reject', rule: skip };
  return { route: 'scoring', rule: skip }; // cooldown / authoritative star: the scorer's own rules decide
}

/** The fields to write for a decision (the caller writes them through safeWriteReview). */
function limboStamp(decision, nowIso) {
  const out = { limboRoute: decision.route, limboRule: decision.rule || null, limboRoutedAt: nowIso, ...(decision.flag || {}) };
  if (decision.route === 'refetch') out.needsRefetch = true;
  return out;
}

/** Apply a decision to a record: stamp fields, delete the fields it clears. */
function applyDecision(d, decision, nowIso) {
  const out = { ...d, ...limboStamp(decision, nowIso) };
  for (const k of decision.clear || []) delete out[k];
  return out;
}

module.exports = { GRACE_DAYS, SCOREABLE_TIERS, DECIDED_FLAGS, isLimboCandidate, classifyLimbo, misattributedWetRoundup, limboStamp, applyDecision, shortTitleEvidence };
