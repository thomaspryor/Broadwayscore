'use strict';

/**
 * critic-consensus-inputs.js: what generate-critic-consensus.js summarises,
 * and the fingerprint it stores, in one place (BRO-4869).
 *
 * The generator writes reviewCount/meanScore into data/critic-consensus.json
 * from the review TEXTS it could read (loadReviewTexts below). The contamination
 * audit used to compare those numbers against every scored reviews.json row,
 * so a text-light show (West End star-rated rows with no readable text) read
 * as permanent drift: glass-kill-bluebeard-and-imp-west-end-2019 "4 vs 16",
 * grease-2007 "mean 33 vs 53", although regenerating would write the same
 * numbers again. Both sides now build the same inputs and the same fingerprint
 * from this module, so the audit compares like with like.
 */

const { isReviewTextFile } = require('./review-text-sidecars');
const fs = require('fs');
const path = require('path');

const DEFAULT_REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');

/** Review-text excerpt fields used when a file has no fullText. */
// The shared list (BRO-6226 cousin: a hand-kept 5-field copy dropped West End
// excerpts such as stagedoorExcerpt that the scorer accepts).
const { EXCERPT_FIELDS } = require('./excerpt-fields');

/**
 * The generator's input row for one review-text file, or null when the file
 * is excluded or carries no text.
 * @param {object} data parsed review-text JSON
 * @param {string} showId
 * @param {Set<string>|null} liveOutlets `${showId}|${outletId}` keys (liveOutletKeys), or null for no filter
 * @param {((name: string) => string)|null} [normalizeOutlet] alias resolver (review-normalization's). Injected, not
 *   required here: the audit that shares this module must stay write-free across its require
 *   graph (safe-form allowlist), and review-normalization pulls in exclusion-logger.
 * @param {{show?: object, filePath?: string, isScoreable?: (data: object, show?: object, filePath?: string) => boolean}} [ctx]
 *   the shows.json row, the file's path and the scorer's own predicate (scripts/lib/is-scoreable.js,
 *   injected for the same write-free reason as normalizeOutlet). With both, a file the scorer and
 *   the rebuild drop (duplicateOf pointing at a live twin, syndication copy, a wrongProduction the
 *   scorer would not clear) is not fed to the LLM either (BRO-6226).
 */
/**
 * True when the review file survives the exclusion flags and, when injected,
 * the scorer's predicate: the rows the rebuild keeps before its dedup.
 */
function passesExclusions(data, ctx = {}) {
  if (!data || typeof data !== 'object') return false;
  if (data.duplicateOf || data.wrongProduction || data.wrongShow || data.wrongAttribution ||
      data.isRoundupArticle || data.rejectionReason || data.contentTier === 'invalid') return false;
  // BRO-6226: the scorer's predicate, not a hand-kept subset of it.
  if (ctx.isScoreable && ctx.filePath && !ctx.isScoreable(data, ctx.show, ctx.filePath)) return false;
  return true;
}

function reviewTextInput(data, showId, liveOutlets = null, normalizeOutlet = null, ctx = {}) {
  if (!passesExclusions(data, ctx)) return null;
  // Only outlets the site actually shows for this show: the rebuild's guards
  // exclude more than the flags above, and a Critics' Take written from an
  // excluded review (another production, another show) is wrong on the page
  // (BRO-4852; 858 such inputs across 1,289 takes on 2026-10-08). Same outlet
  // normalisation the rebuild applies to reviews.json rows
  // (rebuild-all-reviews.js normalizeOutletCanonical), so an alias such as
  // metro -> metro-uk still matches.
  if (liveOutlets && !liveOutlets.has(`${showId}|${data.outletId}`)
      && !(normalizeOutlet && liveOutlets.has(`${showId}|${normalizeOutlet(data.outletId || data.outlet)}`))) return null;

  // Collect all available text (prefer full text, fall back to excerpts)
  const textParts = data.fullText ? [data.fullText] : EXCERPT_FIELDS.map(f => data[f]).filter(Boolean);
  if (textParts.length === 0) return null;
  return {
    outlet: data.outlet,
    critic: data.criticName,
    text: textParts.join('\n\n'),
    score: data.assignedScore,
    url: data.url || null,
    outletId: data.outletId || null,
    publishDate: data.publishDate,
    hasFullText: !!data.fullText,
  };
}

/**
 * Review texts the generator summarises for a show.
 * @param {string} showId
 * @param {Set<string>|null} liveOutlets
 * With opts.isScoreable and opts.createDedup (the generator passes
 * scripts/lib/is-scoreable.js and scripts/lib/within-show-dedup.js), files go
 * through the scorer's predicate and then the rebuild's within-show dedup
 * (same URL, same outlet+critic, an unknown-critic stub beside a named
 * critic), named critics first, so a live outlet's duplicate stubs are not
 * counted or summarised twice (BRO-6226: Benjamin Button had 30 inputs for 27
 * published reviews). Both are injected, not required, because the
 * contamination audit sharing this module must stay write-free across its
 * require graph and review-guards is not; the audit runs without them, so its
 * drift count can sit a few rows above the generator's (thresholds are 10/15).
 * With opts.show and opts.shows (shows.json entries), review texts the show carries from its
 * priorRuns siblings are read too (carriedTextFiles, BRO-7539).
 * @param {{reviewTextsDir?: string, onWarn?: (msg: string) => void, normalizeOutlet?: (name: string) => string, show?: object, shows?: object[],
 *   isScoreable?: (data: object, show?: object, filePath?: string) => boolean,
 *   createDedup?: () => {isDuplicate: (data: object) => boolean, add: (data: object) => void}}} [opts]
 * @returns {object[]}
 */
function loadReviewTexts(showId, liveOutlets = null, opts = {}) {
  const root = opts.reviewTextsDir || DEFAULT_REVIEW_TEXTS_DIR;
  const reviews = [];
  const dedup = opts.createDedup ? opts.createDedup() : null;

  /** Take one parsed file: dedup, then the generator's input row (keyed to `showId`). */
  const take = (data, ctx) => {
    if (dedup) {
      if (dedup.isDuplicate(data)) return;
      // Register every row the rebuild keeps, even one with no text or no
      // live row here, so an --unknown stub at the same outlet still reads
      // as its duplicate (the rebuild dedups before any text check).
      if (passesExclusions(data, ctx)) dedup.add(data);
    }
    const row = reviewTextInput(data, showId, liveOutlets, opts.normalizeOutlet || null, ctx);
    if (row) {
      // BRO-7539: tag rows read from an earlier run's folder, so the fingerprint can
      // tell "a review of THIS run arrived" from "carried rows only".
      if (ctx.carried) row.carried = true;
      reviews.push(row);
    }
  };

  const dir = path.join(root, showId);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter(f => isReviewTextFile(f)).sort(namedBeforeUnknown)) {
      try {
        const filePath = path.join(dir, file);
        take(JSON.parse(fs.readFileSync(filePath, 'utf-8')), { show: opts.show, filePath, isScoreable: opts.isScoreable });
      } catch (err) {
        if (opts.onWarn) opts.onWarn(`Failed to parse ${file}: ${err.message}`);
      }
    }
  }

  // BRO-7644: on opening night the lane writes reviews.json rows (with
  // fullText and assignedScore) hours before it pushes the review-text files,
  // so the Critics' Take, and the email draft it gates, waited for the lane to
  // end. When the show's own folder yields fewer than 2 scored inputs, add its live rows.
  // They already passed the rebuild's guards, so the exclusion flags apply but
  // the file-path scorer predicate does not.
  // Counted on SCORED inputs: the Fantasticks folder held three excluded or
  // unscored early files, so a zero-length test never fired.
  // Live scores first, so a file the rebuild scores counts toward the gate below.
  if (Array.isArray(opts.liveRows)) applyLiveScores(reviews, showId, opts.liveRows, opts);
  if (reviews.filter(r => r.score != null).length < 2 && Array.isArray(opts.fallbackRows)) {
    for (const r of opts.fallbackRows) {
      if (!r || r.showId !== showId) continue;
      if (dedup && dedup.isDuplicate(r)) continue;
      const row = reviewTextInput(r, showId, liveOutlets, opts.normalizeOutlet || null, { show: opts.show });
      if (row) {
        if (dedup) dedup.add(r);
        row.fromLiveRows = true;
        reviews.push(row);
      }
    }
  }

  // BRO-7539: the earlier-run entries this show carries via priorRuns (the
  // rebuild's inheritPriorRunReviews rule, reused through collectCarriedFiles)
  // hold their review TEXTS in their own folders. reviews.json already shows
  // those rows under this show's id, so without them a transfer such as
  // Pride at the Bridge had 25 live rows, 0 readable texts and no Critics' Take.
  // Own files go first, so the dedup above drops a carried twin (same URL, same
  // outlet+critic) exactly as inheritPriorRunReviews drops it.
  for (const d of carriedTextFiles(opts.show, opts.shows, root, opts)) {
    take(d, { show: d._ctxShow, filePath: d._srcPath, isScoreable: opts.isScoreable, carried: true });
  }
  if (Array.isArray(opts.liveRows)) applyLiveScores(reviews, showId, opts.liveRows, opts);
  return reviews;
}

/**
 * Use the score the site shows, not the review-text file's assignedScore.
 * The rebuild corrects scores on the way to reviews.json (star-band clamp:
 * a 4/5 review the LLM scored 59 shows as 80), so a take written from the
 * raw file score called three 4/5-star raves "split" (the-dead-1904-off-
 * broadway-2026, 2026-11-22). Matched on URL, then outlet + critic; rows with
 * no live twin keep their file score. Mutates and returns `reviews`.
 * @param {object[]} reviews generator inputs from loadReviewTexts
 * @param {string} showId
 * @param {object[]} liveRows reviews.json rows
 * @param {{normalizeOutlet?: (name: string) => string, canonicalizeUrl?: (url: string) => string}} [opts]
 *   injected (not required) so the write-free audit can share this module
 */
function applyLiveScores(reviews, showId, liveRows, opts = {}) {
  const normalizeOutlet = opts.normalizeOutlet || null;
  const canonUrl = opts.canonicalizeUrl || null;
  const norm = v => String(v || '').trim().toLowerCase();
  const urlKey = v => (v ? norm(canonUrl ? canonUrl(v) : v) : '');
  const outletKey = v => norm(normalizeOutlet && v ? normalizeOutlet(v) : v);
  const criticKey = v => {
    const c = norm(v).replace(/\s+/g, ' ');
    return !c || /^(unknown|unnamed|staff|anonymous)$/.test(c) ? '' : c;
  };
  // Index only identities that name ONE live score: a roundup URL shared by
  // several critics, or two unnamed reviews at one outlet, would hand one
  // review another's score, so ambiguous keys are dropped (file score kept).
  const byUrl = new Map();
  const byOutletCritic = new Map();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const put = (m, k, v) => { if (!k) return; m.set(k, m.has(k) && !same(m.get(k), v) ? null : v); };
  for (const r of liveRows) {
    if (!r || r.showId !== showId || typeof r.assignedScore !== 'number') continue;
    if (!passesExclusions(r)) continue;
    const ok = `${outletKey(r.outletId || r.outlet)}|${criticKey(r.criticName)}`;
    put(byUrl, urlKey(r.url), { score: r.assignedScore, ok });
    if (criticKey(r.criticName)) put(byOutletCritic, ok, r.assignedScore);
  }
  for (const row of reviews) {
    if (row.fromLiveRows) continue;
    const ok = `${outletKey(row.outletId || row.outlet)}|${criticKey(row.critic)}`;
    let live;
    const u = byUrl.get(urlKey(row.url));
    // A URL hit counts only when that live row is the same review (same outlet
    // and critic, or the file has no named critic).
    if (u && (u.ok === ok || !criticKey(row.critic))) live = u.score;
    if (live === undefined && criticKey(row.critic)) {
      const v = byOutletCritic.get(ok);
      if (typeof v === 'number') live = v;
    }
    if (typeof live === 'number' && live !== row.score) {
      row.fileScore = row.score;
      row.score = live;
    }
  }
  return reviews;
}

/**
 * Review-text files the rebuild carries onto `show` from its priorRuns
 * siblings. Needs opts.shows (every shows.json entry); without it nothing is
 * carried, so a caller that has no show list keeps the own-folder behaviour.
 * Includability is judged against the sibling that holds the file, and the
 * window / inheritReviews / 5-outlet rules are prior-run-sibling's own.
 * @returns {object[]} copies tagged _ctxShow, _srcPath, _carriedFromShowId
 */
function carriedTextFiles(show, shows, root, opts = {}) {
  if (!show || !Array.isArray(shows) || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return [];
  const { collectCarriedFiles, priorRunClassifier } = require('./prior-run-sibling');
  const cache = new Map();
  const loadFiles = (id) => {
    if (cache.has(id)) return cache.get(id);
    const out = [];
    const d = path.join(root, id);
    if (fs.existsSync(d)) {
      for (const file of fs.readdirSync(d).filter(f => isReviewTextFile(f)).sort(namedBeforeUnknown)) {
        try {
          const filePath = path.join(d, file);
          out.push({ ...JSON.parse(fs.readFileSync(filePath, 'utf-8')), _srcPath: filePath });
        } catch (err) {
          if (opts.onWarn) opts.onWarn(`Failed to parse ${id}/${file}: ${err.message}`);
        }
      }
    }
    // The show's own folder as the rebuild sees it: only includable files count
    // toward collectCarriedFiles' 5-outlet separation (the rebuild counts kept
    // rows, not every file on disk) and toward who reviewed the return.
    const kept = id === show.id ? out.filter(f => passesExclusions(f, { show, filePath: f._srcPath, isScoreable: opts.isScoreable })) : out;
    cache.set(id, kept);
    return kept;
  };
  const isCovered = (d, sibling) => passesExclusions(d, { show: sibling, filePath: d._srcPath, isScoreable: opts.isScoreable });
  const carried = collectCarriedFiles(show, shows, { loadFiles, isCovered });
  if (carried.length === 0) return carried;
  // The rebuild's one-review-per-outlet rule (supersededPriorRunReviews, BRO-4954):
  // an outlet that reviewed the return drops its earlier-run review, even with a
  // different critic, which the per-outlet liveOutlets check and the same-critic
  // dedup would both let through.
  const { isCurrent } = priorRunClassifier(show, shows);
  const outletKey = r => String(r.outletId || r.outlet || '').trim().toLowerCase();
  const currentOutlets = new Set(loadFiles(show.id).filter(isCurrent).map(outletKey).filter(Boolean));
  return carried.filter(d => !currentOutlets.has(outletKey(d)));
}

const UNKNOWN_FILE_RE = /--(unknown|unnamed)\b/i;
/** Named-critic files before unknown stubs, then by name (the rebuild's dedup order). */
function namedBeforeUnknown(a, b) {
  return Number(UNKNOWN_FILE_RE.test(a)) - Number(UNKNOWN_FILE_RE.test(b)) || a.localeCompare(b);
}

/** Positive >= 61, mixed 40-60, negative < 40 (generator's buckets). */
function bucketOf(score) {
  if (score >= 61) return 'positive';
  if (score >= 40) return 'mixed';
  return 'negative';
}

/**
 * The change-detection fingerprint the generator stores beside each take.
 * @param {{score?: number|null, hasFullText?: boolean}[]} reviews generator inputs
 * @returns {{reviewCount: number, fullTextCount: number, meanScore: number|null, bucketBreakdown: {positive: number, mixed: number, negative: number}}}
 */
function consensusFingerprint(reviews) {
  const rows = reviews || [];
  const scored = rows.filter(r => typeof r.score === 'number');
  // Internal change-detection fingerprint over score bands (the generator's
  // inputs carry live reviews.json scores when liveRows is passed; the audit's
  // auditInputFingerprint stays on raw file scores, so drift compares raw to raw). Not shown to
  // readers, and the generator inputs carry no verdict (BRO-6729: user-facing
  // counters use the verdict via scripts/lib/review-breakdown.js).
  const bucketBreakdown = { positive: 0, mixed: 0, negative: 0 };
  for (const r of scored) bucketBreakdown[bucketOf(r.score)]++;
  return {
    reviewCount: rows.length,
    fullTextCount: rows.filter(r => r.hasFullText).length,
    // BRO-7539: rows from the show's own folder (not carried via priorRuns). A transfer's
    // first reviews replace carried ones outlet by outlet, so the total can stay flat.
    ownReviewCount: rows.filter(r => !r.carried).length,
    meanScore: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null,
    bucketBreakdown,
  };
}

/**
 * BRO-7558: the fingerprint of the unfiltered, write-free input view the
 * contamination audit can rebuild (no isScoreable, no within-show dedup, no
 * outlet normalizer: those pull review-guards into the audit's require graph,
 * which must stay write-free). Since BRO-6226 the generator stores the
 * FILTERED fingerprint in reviewCount/meanScore, so comparing those to the
 * audit's unfiltered rebuild drifted by 12-27 rows on shows the generator
 * itself judged current (Spies 24 vs 36, Jesus Christ Superstar 12 vs 39).
 * The generator stores this alongside, and consensusDriftFlags compares like
 * with like. Both callers go through this one function.
 * @param {string} showId
 * @param {Set<string>|null} liveOutlets
 * @param {{reviewTextsDir?: string, show?: object, shows?: object[]}} [opts]
 * @returns {{auditReviewCount: number, auditMeanScore: number|null}}
 */
function auditInputFingerprint(showId, liveOutlets, opts = {}) {
  const fp = consensusFingerprint(loadReviewTexts(showId, liveOutlets, {
    reviewTextsDir: opts.reviewTextsDir, show: opts.show, shows: opts.shows,
  }));
  return { auditReviewCount: fp.reviewCount, auditMeanScore: fp.meanScore };
}

/**
 * Determine if a show's consensus should be regenerated.
 * Returns { should: boolean, reason: string }
 */
function shouldRegenerate(existing, reviews) {
  if (!existing) return { should: true, reason: 'new show (no existing consensus)' };

  const currentReviewCount = reviews.length;
  const currentFullTextCount = reviews.filter(r => r.hasFullText).length;
  const scoredReviews = reviews.filter(r => r.score != null);
  const currentMeanScore = scoredReviews.length > 0
    ? Math.round(scoredReviews.reduce((a, r) => a + r.score, 0) / scoredReviews.length)
    : null;

  // Trigger 1: New reviews added (existing behavior)
  const reviewCountDiff = currentReviewCount - (existing.reviewCount || 0);
  if (reviewCountDiff >= 3) {
    return { should: true, reason: `${reviewCountDiff} new reviews` };
  }

  // Trigger 2: Full text upgrades (excerpt → full text)
  if (existing.fullTextCount != null) {
    const fullTextGain = currentFullTextCount - existing.fullTextCount;
    if (fullTextGain >= 3) {
      return { should: true, reason: `${fullTextGain} reviews upgraded to full text` };
    }
  }

  // Trigger 2b (BRO-7539): a review of this run itself arrived. On a transfer the
  // carried reviews are replaced outlet by outlet, so the count, the mean and the
  // buckets can all stay put while the Take is still about the earlier run.
  const currentOwn = reviews.filter(r => !r.carried).length;
  if (existing.ownReviewCount != null && currentOwn > existing.ownReviewCount) {
    return { should: true, reason: `${currentOwn - existing.ownReviewCount} new review(s) of this run` };
  }

  // Trigger 3: Reviews removed (wrongProduction flags, etc.)
  if (reviewCountDiff <= -2) {
    return { should: true, reason: `${Math.abs(reviewCountDiff)} reviews removed` };
  }

  // Trigger 4: Mean score drift (rescoring, rave calibration)
  if (existing.meanScore != null && currentMeanScore != null) {
    const scoreDrift = Math.abs(currentMeanScore - existing.meanScore);
    if (scoreDrift >= 8) {
      return { should: true, reason: `mean score shifted ${scoreDrift}pts (${existing.meanScore} → ${currentMeanScore})` };
    }
  }

  // Trigger 5: Bucket breakdown changed (e.g., review rescored from Mixed to Positive)
  if (existing.bucketBreakdown) {
    const currentBuckets = { positive: 0, mixed: 0, negative: 0 };
    for (const r of scoredReviews) {
      if (r.score >= 61) currentBuckets.positive++;
      else if (r.score >= 40) currentBuckets.mixed++;
      else currentBuckets.negative++;
    }
    const prev = existing.bucketBreakdown;
    if (prev.positive !== currentBuckets.positive || prev.mixed !== currentBuckets.mixed || prev.negative !== currentBuckets.negative) {
      return { should: true, reason: `bucket breakdown changed (P:${prev.positive}/M:${prev.mixed}/N:${prev.negative} → P:${currentBuckets.positive}/M:${currentBuckets.mixed}/N:${currentBuckets.negative})` };
    }
  }

  return { should: false };
}

const REVIEWCOUNT_DRIFT_THRESHOLD = 10;
const MEANSCORE_DRIFT_THRESHOLD = 15;

/**
 * Audit drift flags between a stored take and the inputs it would be
 * regenerated from today. `current` must be built the way the generator built
 * `stored` (consensusFingerprint over loadReviewTexts), otherwise the gap is
 * the source mismatch, not staleness.
 * @param {{reviewCount?: number, meanScore?: number|null}} stored
 * @param {{reviewCount: number, meanScore: number|null}} current
 * @returns {string[]}
 */
function consensusDriftFlags(stored, current) {
  const flags = [];
  if (!stored || !current) return flags;
  // BRO-7558: a record stamped with the audit's own unfiltered fingerprint is
  // compared with that; an older record falls back to the generator's count.
  const storedCount = typeof stored.auditReviewCount === 'number' ? stored.auditReviewCount : (stored.reviewCount || 0);
  const rcDiff = Math.abs(storedCount - current.reviewCount);
  if (rcDiff >= REVIEWCOUNT_DRIFT_THRESHOLD) {
    flags.push(`REVIEWCOUNT_DRIFT:consensus=${storedCount},actual=${current.reviewCount},diff=${rcDiff}`);
  }
  // No stored or current mean = nothing to drift from (generator's own guard).
  const storedMean = 'auditMeanScore' in stored ? stored.auditMeanScore : stored.meanScore;
  if (storedMean != null && current.meanScore != null) {
    const msDiff = Math.abs(storedMean - current.meanScore);
    if (msDiff >= MEANSCORE_DRIFT_THRESHOLD) {
      flags.push(`MEANSCORE_DRIFT:consensus=${storedMean},actual=${Math.round(current.meanScore)},diff=${Math.round(msDiff)}`);
    }
  }
  return flags;
}

module.exports = {
  DEFAULT_REVIEW_TEXTS_DIR,
  REVIEWCOUNT_DRIFT_THRESHOLD,
  MEANSCORE_DRIFT_THRESHOLD,
  reviewTextInput,
  passesExclusions,
  namedBeforeUnknown,
  loadReviewTexts,
  applyLiveScores,
  bucketOf,
  consensusFingerprint,
  auditInputFingerprint,
  shouldRegenerate,
  consensusDriftFlags,
};
