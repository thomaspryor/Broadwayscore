'use strict';

const fs = require('fs');
const path = require('path');

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
    };
  }

  return {
    ok: false,
    severity: 'error',
    message: violations.map(v =>
      `${v.outletId}/${v.criticName} (${v.filename}) SHIPPED with CV.wrongProduction=true (${v.cvConfidence} confidence) and no clear flag; reasoning: ${v.cvReasoning || '(none)'} — ${v.url}`
    ).join('\n'),
    details: { violations, showId: show.id, requiredClearFlags: CLEAR_FLAGS },
  };
}

module.exports = { name, description, run, CLEAR_FLAGS };
