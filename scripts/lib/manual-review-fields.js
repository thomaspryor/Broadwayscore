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
    fields.wrongArticleManualClear = true;
    fields.humanReviewedWrongProduction = false;
    fields.humanReviewedWrongArticle = false;
    fields.allowEarlyDate = true;
    fields.allowLateDate = true;
    fields.allowCrossMarket = true;
    fields.allowTourSignal = true;
    fields.allowFilmSignal = true;
    fields.contentVerification = {
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
      'wrongArticleManualClear',
      'humanReviewedWrongProduction',
      'humanReviewedWrongArticle',
      'allowEarlyDate',
      'allowLateDate',
      'allowCrossMarket',
      'allowTourSignal',
      'allowFilmSignal',
      'contentVerification',
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
 * @param {boolean} [opts.forceClearStale] Bypass the stale-flag check (--force-clear-stale-flag)
 * @param {object}  [opts.fs]              Injected fs for tests
 * @param {object}  [opts.path]            Injected path for tests
 * @returns {{ ok: true } | { ok: false, reason: string, file?: string, detail?: object }}
 */
function detectIngestCollision(opts = {}) {
  const fs = opts.fs || require('fs');
  const path = opts.path || require('path');
  const { showDir, outletId, criticName, url, publishDate, forceClearStale } = opts;

  if (!showDir || !fs.existsSync(showDir)) return { ok: true };
  if (!outletId) return { ok: true };

  const { normalizeOutlet, normalizeCritic } = require('./review-normalization');
  const normalizedOutlet = normalizeOutlet(outletId);
  const normalizedCritic = criticName && criticName.toLowerCase() !== 'unknown'
    ? normalizeCritic(criticName)
    : null;

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
    const urlMatches = url && data.url && _normUrl(url) === _normUrl(data.url);
    const hasStaleFlag = data.wrongProduction === true
      || data.wrongShow === true
      || data.wrongProductionAutoCleared === true;
    if (hasStaleFlag && !urlMatches && !forceClearStale) {
      return {
        ok: false,
        file,
        reason: 'stale-flag-on-existing-file',
        detail: {
          existingUrl: data.url || null,
          existingFlags: {
            wrongProduction: data.wrongProduction === true,
            wrongShow: data.wrongShow === true,
            wrongProductionAutoCleared: data.wrongProductionAutoCleared === true,
          },
          existingPublishDate: data.publishDate || null,
          incomingUrl: url || null,
          incomingPublishDate: publishDate || null,
        },
      };
    }

    // Wide publishDate gap = likely a different production of the same show.
    if (publishDate && data.publishDate && !forceClearStale) {
      const existingMs = Date.parse(data.publishDate);
      const incomingMs = Date.parse(publishDate);
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

module.exports = { buildManualReviewFields, REQUIRED_PROTECTION_FIELDS, detectIngestCollision };
