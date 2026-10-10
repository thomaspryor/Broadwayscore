/**
 * Pure field-building logic for ingest-manual-review.js.
 *
 * Extracted per CLAUDE.md rule 15 (test extraction pattern) so the "8 protection
 * fields must always be set" invariant can be asserted in tests — the Beaches
 * 2026-04-22 opening night silently dropped 4 reviews because an earlier version
 * of this block set only 3 of the needed fields.
 *
 * Consumers: scripts/ingest-manual-review.js.
 *
 * The 8 protection fields this module guarantees:
 *   wrongProduction=false, wrongProductionManualClear=true,
 *   allowEarlyDate=true, wrongShow=false,
 *   contentVerification.wrongProduction=false,
 *   contentVerification.wrongArticle=false,
 *   manualContentTier='complete' (only when fullText is present),
 *   humanReviewedWrongProduction=false
 */

const REQUIRED_PROTECTION_FIELDS = [
  'wrongProduction',
  'wrongProductionManualClear',
  'allowEarlyDate',
  'wrongShow',
  'humanReviewedWrongProduction',
  // Nested contentVerification.* pair + manualContentTier are checked separately
  // because they depend on presence of other inputs.
];

/**
 * Build the review-text field payload for ingest-manual-review.js.
 *
 * @param {object} opts
 * @param {number|null} [opts.humanScore]       Explicit score 1-100 (goes to humanReviewScore)
 * @param {boolean} [opts.provisional=false]    When true, humanReviewScoreProvisional=true so
 *                                              rebuild-helpers.js:P0 lets LLM scores override
 *                                              once real scoring runs. Default false = LOCKED
 *                                              (the Rocky Horror 2026-04-23 Helen Shaw case).
 * @param {string|null} [opts.fullText]         Review body text
 * @param {string|null} [opts.originalScore]    Raw rating string ("3/5", "B+", etc.)
 * @param {string|null} [opts.originalScoreSource] Extractor label ("manual-stars")
 * @param {number|null} [opts.publishDate]      YYYY-MM-DD
 * @returns {object} Field payload ready for createOrMergeReviewFile
 */
function buildManualReviewFields(opts = {}) {
  const {
    humanScore = null,
    provisional = false,
    fullText = null,
    originalScore = null,
    originalScoreSource = null,
    publishDate = null,
    // operatorTrust=true (default) → a human operator vouched for this review
    // (interactive ingest-manual-review.js): apply the full override set that
    // exempts it from wrong-production / cross-market / date guards.
    // operatorTrust=false → AUTOMATED / public-form ingest (audit-aggregator-gap
    // → ingest-review-from-url, poll-loureviews): build a NORMAL review subject
    // to every guard. Stamping operator trust on machine-ingested aggregator URLs
    // made them immune to wrong-production detection and re-admitted prior-
    // production / cross-market contamination on every rebuild (2026-06-21:
    // 335 reviews / 160 shows — Stranger Things West End reviews on the Broadway
    // entry, Devil Wears Prada Chicago tryout on the WE entry). Notion 386637c5.
    operatorTrust = true,
  } = opts;

  const fields = {};

  if (fullText) {
    fields.fullText = fullText;
    fields.textFetchedAt = new Date().toISOString();
    // Operator manual entry records 'manual-entry' + locks the content tier so
    // rebuild doesn't reclassify. Automated URL ingest must NOT lie about either:
    // it is subject to normal content classification and all inclusion guards.
    fields.fetchMethod = operatorTrust ? 'manual-entry' : 'url-ingest';
    if (operatorTrust) fields.manualContentTier = 'complete';
  }

  if (humanScore) {
    // humanReviewScore is the ONLY score field rebuild respects.
    // provisional=false (default) → LOCKED, resolver returns it at P0.
    // provisional=true → operator wants LLM to override once real scoring lands.
    // Semantic wired in scripts/lib/rebuild-helpers.js getBestScore.
    fields.humanReviewScore = humanScore;
    fields.humanReviewScoreProvisional = !!provisional;
  }

  // OPERATOR-TRUST OVERRIDE SET — applied ONLY when a human operator vouched for
  // this review (operatorTrust=true, the default). Missing any one means a
  // different guard re-flags the review. These survive rebuild scoring, content
  // reclassification, wrong-production flagging, wrong-show classification,
  // pre-opening date guards, tour/film-signal guards, and cross-market re-routing.
  // The Beaches 2026-04-22 opening silently dropped 4 reviews because this block
  // only set 3 of the needed fields. Automated callers pass operatorTrust=false
  // and skip this entirely so the review stays subject to every guard.
  if (operatorTrust) {
    fields.wrongProduction = false;
    fields.wrongProductionManualClear = true;
    fields.wrongProductionOverride = true;
    fields.wrongShow = false;
    fields.wrongShowManualClear = true;
    // Task #1695 fast-follow: maybeUpgradeUrl() now refuses a URL swap on any
    // contentTier:'invalid' file that still carries duplicateOf (protects a
    // legitimate flag-driven exclusion from being silently un-set — see
    // review-normalization.js). An operator vouching for this review via
    // manual ingest is asserting it's NOT a duplicate, so duplicateOf must be
    // force-cleared here or the operator has no escape hatch: the new guard
    // would keep refusing their corrected URL forever.
    fields.duplicateOf = null;
    fields.duplicateReason = null;
    fields.duplicateClearReason = 'Manual ingest: operator vouched for this review as independent (not a duplicate)';
    fields.isNonReview = false;
    fields.nonReviewManualClear = true;
    fields.wrongArticleManualClear = true;
    fields.humanReviewedWrongProduction = false;
    fields.humanReviewedWrongArticle = false;
    fields.allowEarlyDate = true;
    fields.allowLateDate = true;
    fields.allowCrossMarket = true;
    fields.allowTourSignal = true;
    fields.allowFilmSignal = true;
    // Neutralize the stale verdict that got the file excluded in the first
    // place. Clearing only the booleans left rejectionReason='not_a_review' +
    // wrongShowReason + the old CV block in place, and explainExclusion still
    // excluded the review (America, Who Hurt You? NYSR, 2026-09-22: an LLM
    // verifier judged a 700-char truncation a "preview"; the operator-vouched
    // re-ingest stayed hidden). Same recipe as
    // memory/feedback_manual_review_protection_fields.md.
    fields.rejectionReason = null;
    // wrongShowReason is write-guard protected: when the file already carries
    // wrongShowManualClear the guard keeps the old text. Harmless for
    // inclusion (review-guards only re-promotes it via contentVerificationPromoted,
    // nulled here), so it is not added to protectedFields below.
    fields.wrongShowReason = null;
    fields.isNonReviewReason = null;
    fields.contentVerificationPromoted = null;
    fields.contentVerification = {
      isValid: true,
      confidence: 'manual',
      verifiedBy: 'manual-ingest',
      wrongProduction: false,
      wrongArticle: false,
    };

    // Per-file protection lock — unions with global PROTECTED_FIELDS in
    // review-write-guard.js so these exact fields can't be silently dropped
    // on rebase even if one of them is later removed from the global list.
    // See memory/feedback_per_file_protected_fields_lock.md (Beaches 2026-04-22).
    fields.protectedFields = [
      'humanReviewScore',
      'humanReviewScoreProvisional',
      'manualContentTier',
      'wrongProduction',
      'wrongProductionManualClear',
      'wrongProductionOverride',
      'wrongShow',
      'wrongShowManualClear',
      'duplicateOf',
      'duplicateReason',
      'duplicateClearReason',
      'isNonReview',
      'nonReviewManualClear',
      'wrongArticleManualClear',
      'humanReviewedWrongProduction',
      'humanReviewedWrongArticle',
      'allowEarlyDate',
      'allowLateDate',
      'allowCrossMarket',
      'allowTourSignal',
      'allowFilmSignal',
      'contentVerification',
      'rejectionReason',
      'isNonReviewReason',
      'contentVerificationPromoted',
      'fullText',
      'textFetchedAt',
      'originalScore',
      'originalScoreSource',
      'originalScoreNormalized',
    ];
  }

  if (originalScore) {
    fields.originalScore = originalScore;
    fields.originalScoreSource = originalScoreSource;
    fields.originalScoreNormalized = humanScore;
  }

  if (publishDate) {
    fields.publishDate = publishDate;
  }

  return fields;
}

/**
 * Detect merge-vs-overwrite collisions before we call createOrMergeReviewFile.
 *
 * The Beaches 2026-04-22 ingest wrote a 2026 URL into a 2015 Chris Jones file
 * (wrongProduction:true) — the flag was preserved and the new review silently
 * dropped from rebuild. RH dodged this only because the operator used a -2026
 * suffix on the show id. Catch it at the source.
 *
 * @param {object} opts
 * @param {string}  opts.showDir           Absolute path to data/review-texts/{showId}
 * @param {string}  opts.outletId          Canonical outlet id
 * @param {string}  opts.criticName        Critic name (may be "Unknown")
 * @param {string}  [opts.url]             Incoming URL
 * @param {string}  [opts.publishDate]     Incoming publishDate (YYYY-MM-DD)
 * @param {string}  [opts.openingDate]     Show opening date (YYYY-MM-DD). When the incoming
 *                                         publishDate falls in this show's opening window, the
 *                                         incoming is the CURRENT production and stale-flag /
 *                                         date-gap collisions against prior-production files are
 *                                         suppressed (revival/returning-production carve-out).
 * @param {object}  [opts.show]          shows.json row. When given, an existing flagged file that is
 *                                         provably a DIFFERENT production (other-production-signal.js)
 *                                         and would not share the incoming's filename is not a collision
 *                                         (BRO-4271: 2023 London files squatted the 2026 Broadway slots).
 * @param {boolean} [opts.forceClearStale] Bypass the stale-flag check (--force-clear-stale-flag)
 * @param {object}  [opts.fs]              Injected fs for tests
 * @param {object}  [opts.path]            Injected path for tests
 * @returns {{ ok: true } | { ok: false, reason: string, file?: string, detail?: object }}
 */
function detectIngestCollision(opts = {}) {
  const fs = opts.fs || require('fs');
  const path = opts.path || require('path');
  const { showDir, outletId, criticName, url, publishDate, forceClearStale, show } = opts;
  const openingDate = opts.openingDate || (show && show.openingDate);

  if (!showDir || !fs.existsSync(showDir)) return { ok: true };
  if (!outletId) return { ok: true };

  const { normalizeOutlet, normalizeCritic } = require('./review-normalization');
  const { hasClearBreadcrumbValue } = require('./flag-contradiction');
  const { isStaleNonReviewSlot, flaggedSlotSupersededBy } = require('./review-slot-guards');
  const normalizedOutlet = normalizeOutlet(outletId);
  const normalizedCritic = criticName && criticName.toLowerCase() !== 'unknown'
    ? normalizeCritic(criticName)
    : null;

  // REVIVAL / RETURNING-PRODUCTION CARVE-OUT (2026-07-04, To Kill a Mockingbird WE):
  // The stale-flag and publish-date-gap blocks below stop a fresh review from silently
  // merging into (and inheriting the flag of) a *prior production's* file. But when the
  // incoming review is itself the CURRENT production — its publishDate falls inside this
  // show's opening window — the existing flagged file is a prior-production sibling, NOT a
  // duplicate. Blocking here was the systemic West End failure: WE is dominated by
  // revivals/returns/transfers reviewed by the same critics, so every major outlet has a
  // prior-production file and every fresh review got dropped → "6 reviews, all minor blogs"
  // every opening. When the incoming is provably current-production we let it through: it
  // writes to a clean file, and findExistingReviewFile skips the flagged prior file as a
  // merge target, so there is no flag inheritance — the Beaches 2026-04-22 protection holds,
  // because that incoming was NOT in-window and would still block here.
  // Pre-opening bound is 30d (not 90d): current-production reviews cluster at press
  // night and during late previews; a 90d pre-opening window would also bless a review
  // of a CONCURRENT prior run (tour/tryout) dated up to a quarter before this opening,
  // which the heuristic downstream production check may not catch (ship-check P1,
  // 2026-07-04). 30d aligns with quickDateCheck's own pre-opening suspicion threshold.
  // Post-opening 365d is safe — a wrong prior production is dated BEFORE this opening.
  const DAY = 86400000;
  const openingMs = openingDate ? Date.parse(openingDate) : NaN;
  const incomingCurMs = publishDate ? require('./date-utils').toDateMs(publishDate) : NaN;
  const incomingIsCurrentProduction = Number.isFinite(openingMs)
    && Number.isFinite(incomingCurMs)
    && incomingCurMs >= openingMs - 30 * DAY
    && incomingCurMs <= openingMs + 365 * DAY;

  let files;
  try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); }
  catch { return { ok: true }; }

  for (const file of files) {
    const parts = file.replace('.json', '').split('--');
    if (parts.length !== 2) continue;
    const [fileOutlet, fileCritic] = parts;
    if (normalizeOutlet(fileOutlet) !== normalizedOutlet) continue;
    if (normalizedCritic && fileCritic !== 'unknown' && normalizeCritic(fileCritic) !== normalizedCritic) continue;

    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8')); }
    catch { continue; }

    // Stale flag on existing file + different URL = the Beaches failure mode.
    // wrongProductionAutoCleared is written as a STRING by every rebuild path
    // and as a boolean by older writers (283 vs 445 in corpus), so `=== true`
    // silently missed the string majority — use the canonical predicate (#1020).
    const urlMatches = url && data.url && _normUrl(url) === _normUrl(data.url);

    // STALE NON-REVIEW SLOT (BRO-4430): a flagged file whose own url is a
    // cast announcement, show/listing page or round-up is not a prior
    // production's review, so it cannot be the Beaches collision. The Body of
    // Mary TheaterMania review was refused 3x against a flagged cast-announcement
    // file. The writer replaces such a file's url (review-slot-guards.js).
    if (!urlMatches && isStaleNonReviewSlot(data, url)) continue;

    // SUPERSEDED FLAGGED SLOT (BRO-4956): a flagged record about another show
    // or production (LBO's Juniper Blood review in the Blood of my Blood
    // folder) cannot hold the slot against a review that is provably this
    // production. The writer retires the flagged file and writes clean.
    if (!urlMatches && show && flaggedSlotSupersededBy(data, { url, publishDate, outletId: normalizedOutlet, criticNamed: !!normalizedCritic }, show)) continue;

    // OTHER-PRODUCTION CARVE-OUT (BRO-4271): an existing file that is provably
    // about a different production (London edition url, London-only outlet, a
    // /2023/ url on a 2026 show, a date well before previews, or flagged text
    // naming a London house) cannot be the same review as a different-url
    // incoming, and when the incoming lands under a different filename there
    // is nothing to merge into. The Beaches protection still holds: a SAME
    // filename (same critic, or both Unknown) keeps blocking, because that
    // write would land on the flagged file.
    // Only for files FLAGGED wrongProduction/wrongShow: findExistingReviewFile
    // never merges into those, so the incoming cannot inherit them. An
    // unflagged (or merely auto-cleared) older file IS a merge target (an
    // --unknown file accepts any named critic), so it keeps blocking.
    const flaggedWrong = data.wrongProduction === true || data.wrongShow === true;
    if (show && !urlMatches && flaggedWrong) {
      const incomingCriticSlug = normalizedCritic || 'unknown';
      const sameFilename = normalizeCritic(fileCritic) === incomingCriticSlug;
      if (!sameFilename) {
        const { otherProductionSignal } = require('./other-production-signal');
        if (otherProductionSignal(data, show, { useText: true })) continue;
      }
    }
    const hasStaleFlag = data.wrongProduction === true
      || data.wrongShow === true
      || hasClearBreadcrumbValue(data.wrongProductionAutoCleared);
    if (hasStaleFlag && !urlMatches && !forceClearStale && !incomingIsCurrentProduction) {
      return {
        ok: false,
        file,
        reason: 'stale-flag-on-existing-file',
        detail: {
          existingUrl: data.url || null,
          existingFlags: {
            wrongProduction: data.wrongProduction === true,
            wrongShow: data.wrongShow === true,
            wrongProductionAutoCleared: hasClearBreadcrumbValue(data.wrongProductionAutoCleared),
          },
          existingPublishDate: data.publishDate || null,
          incomingUrl: url || null,
          incomingPublishDate: publishDate || null,
        },
      };
    }

    // Wide publishDate gap = likely a different production of the same show.
    // Skip when the incoming review is provably this production (in-window): a large gap
    // from a prior-production file is expected, not a collision.
    if (publishDate && data.publishDate && !forceClearStale && !incomingIsCurrentProduction) {
      const existingMs = require('./date-utils').toDateMs(data.publishDate);
      const incomingMs = require('./date-utils').toDateMs(publishDate);
      if (Number.isFinite(existingMs) && Number.isFinite(incomingMs)) {
        const diffDays = Math.abs(existingMs - incomingMs) / 86400000;
        if (diffDays > 365 && !urlMatches) {
          return {
            ok: false,
            file,
            reason: 'publish-date-gap-exceeds-365-days',
            detail: {
              existingPublishDate: data.publishDate,
              incomingPublishDate: publishDate,
              diffDays: Math.round(diffDays),
              existingUrl: data.url || null,
              incomingUrl: url || null,
            },
          };
        }
      }
    }
  }

  return { ok: true };
}

function _normUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^triedRedirect$|^ref$|^mc_eid$/.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).toLowerCase().replace(/\/$/, '');
  }
}

// A final write guard can replace an incoming value with a fresh verdict.
// Preserve that verdict during the clear instead of restoring operator input
// over it. Snapshot the remaining incoming fields before the clear runs.
function prepareManualUrlChangeFields(review, fields) {
  const incoming = {};
  const preserveFields = new Set();
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(review[key]) === JSON.stringify(value)) incoming[key] = value;
    else preserveFields.add(key);
  }
  return { incoming, preserveFields };
}

// Called only after the final writer accepts a URL change. Reset the old
// slot first, then merge the incoming fields that final guards left intact.
function mergeManualUrlChangeFields(review, fields) {
  delete review.excludeFromScoring;
  delete review.rejectedAt;
  delete review.needsRefetch;
  Object.assign(review, fields);
  if (!review.fullText) review.needsRefetch = true;
}

function assertManualReviewBodyPersisted(incomingText, saved, filepath) {
  if (incomingText && (typeof saved.fullText !== 'string' || saved.fullText.length === 0)) {
    throw new Error(`Incoming body was supplied but saved fullText is empty at ${filepath}`);
  }
}

module.exports = { buildManualReviewFields, REQUIRED_PROTECTION_FIELDS, detectIngestCollision, prepareManualUrlChangeFields, mergeManualUrlChangeFields, assertManualReviewBodyPersisted };
