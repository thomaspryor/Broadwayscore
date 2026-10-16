'use strict';

const fs = require('fs');
const path = require('path');
const {
  hasStrongDifferentShowSignal,
  hasNamedDifferentDirectorSignal,
  shouldSkipWrongProductionAudit,
  explainExclusion,
} = require('../review-guards');
const { isWithinPriorRun, isWithinOptOutPriorRun, isWithinTourLeg } = require('../wrong-production-autoclear');
const { parseDate } = require('../date-utils');

const name = 'cv-wrongproduction-unhandled';
const description = 'Source file has contentVerification.wrongProduction=true without top-level clear flag AND still appears in reviews.json (the juan-a-ramirez bypass class)';

/**
 * Clear flags that legitimately keep a CV.wrongProduction=true file in reviews.json:
 * - humanReviewedWrongProduction: true — a human has audited and approved inclusion
 * - wrongProductionManualClear: true — explicit CV override set by a curator
 * - wrongProductionAutoCleared: true — rebuild-time auto-clear for known UK outlets
 *
 * If NONE of these are set AND the review shipped, we have the exact bypass path
 * that let juan-a-ramirez ship as Schmigadoon. Flag with severity=error.
 */
const CLEAR_FLAGS = ['humanReviewedWrongProduction', 'wrongProductionManualClear', 'wrongProductionAutoCleared'];

// The verifier's own temporal-override annotation (content-verifier.js). It is
// written only when applyTemporalOverrides downgraded the LLM's wrongProduction
// verdict to 'low' for a review inside the 30-day opening window, and only
// after its strong-different-show and named-different-director bypasses
// declined to keep the verdict.
const TEMPORAL_OVERRIDE_RE = /\[OVERRIDE: review (?:within \d+d of|near) opening, likely correct production\]/;
// applyTemporalOverrides' window. Re-checked against the CURRENT dates so a
// marker stamped while the file held a stale date near opening is not trusted
// after the date was corrected.
const TEMPORAL_WINDOW_DAYS = 30;
// A curator's written clear reason, not a placeholder or a negation.
const NOT_A_CLEAR_RE = /^(?:false|no|not\b|0|pending|todo|tbd|unclear|unknown)/i;

function withinTemporalWindow(publishDate, openingDate) {
  const p = parseDate(publishDate);
  const o = parseDate(openingDate);
  if (!p || !o || Number.isNaN(p.getTime()) || Number.isNaN(o.getTime())) return false;
  return Math.abs(p.getTime() - o.getTime()) <= TEMPORAL_WINDOW_DAYS * 86400000;
}

/**
 * BRO-5437: why a file that matched a shipped row with CV.wrongProduction=true
 * and no clear flag is nonetheless already handled by a documented pipeline
 * decision, or null when it is a real unhandled case. The lifetime sweep found
 * 1153 hits, almost all in these classes, which buried the real ones:
 *
 * - 'manual-clear-reason': wrongProductionManualClear holds a curator's written
 *   reason (string) instead of the boolean the CLEAR_FLAGS test expects.
 * - 'rebuild-skip-audit': shouldSkipWrongProductionAudit (wrongProductionOverride,
 *   allowCrossMarket, humanReviewedWrongProduction=false), the rebuild's own
 *   "operator overrode the wrongProduction audit" predicate.
 * - 'not-shipped': the file's own top-level wrongProduction flag excludes it
 *   (explainExclusion === 'wrongProduction') AND no shipped row carries this
 *   file's own url+outlet+critic (opts.exactShipped), so the row it matched
 *   belongs to a sibling file (e.g. a mis-split byline).
 * - 'prior-run-or-tour-leg': published inside an operator-declared priorRuns /
 *   tourLegs window, which the rebuild's CV pre-pass deliberately honors
 *   (never an inheritReviews:false window, BRO-5285).
 * - 'temporal-override-low-confidence': the verifier's [OVERRIDE ...] downgrade
 *   to 'low' and the CURRENT strong-different-show / named-director markers
 *   still find nothing (re-run here so a row verified before a marker was added
 *   is re-judged). The juan-a-ramirez class (low + OVERRIDE but explicit
 *   different-show evidence) stays a violation, as does a file whose CURRENT
 *   publishDate is no longer within 30 days of opening.
 *
 * Only the lifetime sweep sets these aside (context.setAsideHandled); the
 * opening-night checklist's ±2-day run still reports every one for a human.
 */
function handledReason(data, show, filePath, opts = {}) {
  const cv = data.contentVerification || {};
  const mc = data.wrongProductionManualClear;
  if (typeof mc === 'string' && mc.trim().length >= 12 && !NOT_A_CLEAR_RE.test(mc.trim())) return 'manual-clear-reason';
  if (shouldSkipWrongProductionAudit(data)) return 'rebuild-skip-audit';
  if (data.wrongProduction === true && show && !opts.exactShipped
      && explainExclusion(data, show, filePath) === 'wrongProduction') return 'not-shipped';
  if (show && ((isWithinPriorRun(data.publishDate, show.priorRuns) && !isWithinOptOutPriorRun(data.publishDate, show.priorRuns))
      || isWithinTourLeg(data.publishDate, show.tourLegs))) {
    return 'prior-run-or-tour-leg';
  }
  if (cv.confidence === 'low' && TEMPORAL_OVERRIDE_RE.test(String(cv.reasoning || ''))
      && show && withinTemporalWindow(data.publishDate, show.openingDate)
      && !hasStrongDifferentShowSignal(cv.issues, cv.reasoning)
      && !hasNamedDifferentDirectorSignal(cv.issues, cv.reasoning, show, data.fullText)) {
    return 'temporal-override-low-confidence';
  }
  return null;
}

function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);
  if (!fs.existsSync(showDir)) {
    return { ok: true, severity: 'ok', message: 'No review-texts dir — skipping' };
  }

  const shippedReviews = context.reviewsDoc[show.id] || [];
  const shippedByUrl = new Set(shippedReviews.map(r => r.url).filter(Boolean));
  // Fallback lookup for files that shipped but have no url field on disk
  // (older imports, manually-curated stubs). Match on (outletId, criticName).
  const shippedByOutletCritic = new Set(
    shippedReviews
      .filter(r => r.outletId && r.criticName)
      .map(r => `${r.outletId}::${r.criticName}`)
  );
  if (shippedByUrl.size === 0 && shippedByOutletCritic.size === 0) {
    return { ok: true, severity: 'ok', message: 'No shipped reviews — skipping' };
  }

  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { ok: true, severity: 'ok', message: `Could not read review-texts dir: ${err.message}` };
  }

  const violations = [];
  const handledCounts = {};
  for (const filename of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8'));
    } catch {
      continue;
    }

    const cv = data.contentVerification;
    if (!cv || cv.wrongProduction !== true) continue;
    const urlMatch = data.url && shippedByUrl.has(data.url);
    const outletCriticMatch = data.outletId && data.criticName
      && shippedByOutletCritic.has(`${data.outletId}::${data.criticName}`);
    if (!urlMatch && !outletCriticMatch) continue;

    // File shipped despite CV.wrongProduction=true. Is any clear flag set?
    const clears = CLEAR_FLAGS.filter(f => data[f] === true);
    if (clears.length > 0) continue;

    // Also respect the top-level wrongProduction=false-with-manual-clear pattern
    if (data.wrongProduction === false && data.wrongProductionManualClear === true) continue;

    const exactShipped = !!data.url && shippedReviews.some(r => r.url === data.url
      && r.outletId === data.outletId && r.criticName === data.criticName);
    const handled = context.setAsideHandled
      ? handledReason(data, show, path.join(showDir, filename), { exactShipped })
      : null;
    if (handled) {
      handledCounts[handled] = (handledCounts[handled] || 0) + 1;
      continue;
    }

    violations.push({
      filename,
      url: data.url || '(no url on file)',
      outletId: data.outletId,
      criticName: data.criticName,
      matchedBy: urlMatch ? 'url' : 'outlet+critic',
      cvConfidence: cv.confidence,
      cvReasoning: cv.reasoning ? String(cv.reasoning).slice(0, 120) : null,
      cvIssues: Array.isArray(cv.issues) ? cv.issues.slice(0, 2) : null,
    });
  }

  if (violations.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `No unhandled CV.wrongProduction files in shipped set`,
      details: { handledCounts },
    };
  }

  const message = violations.map(v =>
    `${v.outletId}/${v.criticName} (${v.filename}) SHIPPED with CV.wrongProduction=true (${v.cvConfidence} confidence) and no clear flag; reasoning: ${v.cvReasoning || '(none)'} — ${v.url}`
  ).join('\n');

  return {
    ok: false,
    severity: 'error',
    message,
    details: {
      violations,
      handledCounts,
      showId: show.id,
      requiredClearFlags: CLEAR_FLAGS,
      // Self-declared remediation (task #389 pattern, extended for BRO-219).
      // alert, not workflow: this IS the juan-a-ramirez bypass class — a
      // heuristic auto-clearing or auto-excluding a wrongProduction review
      // is exactly the risk this check exists to catch, so a human must
      // judge each violation.
      remediation: {
        kind: 'alert',
        key: `cv-wrongproduction-unhandled:${show.id}`,
        conditionKey: `opening-night-cv-wrongproduction-unhandled-${show.id}`,
        title: `Unhandled CV.wrongProduction on ${show.title || show.id}`,
        description: message,
        severity: 'error',
        reason: `${violations.length} shipped review(s) with CV.wrongProduction=true and no clear flag`,
      },
    },
  };
}

module.exports = { name, description, run, handledReason, CLEAR_FLAGS };
