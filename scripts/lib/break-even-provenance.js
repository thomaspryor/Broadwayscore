/**
 * Where a commercial.json record's displayed break-even comes from, and how
 * good it is (BRO-7254). Stored as breakEvenSource / breakEvenQuality, both
 * derived: the commercial write guard re-stamps them on every save, so they
 * follow any cost or model change. Never hand-edit them; fix the cost fields.
 *
 * breakEvenQuality:
 *   reported    - the break-even rests on a weekly cost a named outlet, SEC
 *                 filing or producer reported, with a printable citation
 *                 (isCitedReportedWeeklyCost);
 *   estimated   - it rests on an estimate: an analyst or fan-forum figure,
 *                 our research estimate, or the model's type default /
 *                 comparables when no cost is on file;
 *   unavailable - no break-even is shown (no cost, and no model figure that
 *                 clears the quality floor).
 *
 * breakEvenSource is a plain sentence naming which field holds the figure and
 * what it rests on (no dollar amounts, so a model re-run does not churn it). It
 * never copies weeklyRunningCostSource (analyst handles and forum names stay
 * out of it, policy BRO-5020); it points to that field instead.
 *
 * displayedBreakEvenKind mirrors getBreakEven (src/lib/commercial-display.ts);
 * scripts/closing-watch-breakeven.test.mjs checks the two agree on every
 * record. Pure: no I/O.
 */

const BREAK_EVEN_QUALITIES = ['reported', 'estimated', 'unavailable'];

const METHODOLOGY_LABEL = {
  'trade-reported': 'trade-reported',
  'sec-filing': 'SEC filing',
  'producer-confirmed': 'producer-confirmed',
  'reddit-standard': 'analyst estimate',
  'industry-estimate': 'industry estimate',
  'deep-research': 'research estimate',
};

const isPositive = (n) => Number.isFinite(n) && n > 0;

/** Same floor as meetsModelQualityFloor in src/lib/commercial-display.ts. */
function meetsModelQualityFloor(rec) {
  return rec.modelDataQuality !== 'low' && rec.modelMethod !== 'ai-estimated';
}

/**
 * Which figure getBreakEven shows: 'model' (modelBreakeven), 'cost'
 * (weeklyRunningCost, including a stale model below the cost), or null.
 */
function displayedBreakEvenKind(rec) {
  if (!rec) return null;
  const cost = isPositive(rec.weeklyRunningCost) ? rec.weeklyRunningCost : null;
  if (rec.modelBreakeven && meetsModelQualityFloor(rec)) {
    const stale = cost != null && rec.modelBreakeven < cost && rec.weeklyRunningCostBasis !== 'all-in';
    return stale ? 'cost' : 'model';
  }
  return cost != null ? 'cost' : null;
}

function costIsCitedReported(rec) {
  // Lazy: waltz-cost-gap-fill requires commercial-record-checks, which requires this file.
  const { isCitedReportedWeeklyCost } = require('./waltz-cost-gap-fill');
  return isCitedReportedWeeklyCost(rec);
}

/** { breakEvenSource, breakEvenQuality } for one record. */
function breakEvenProvenance(rec) {
  const kind = displayedBreakEvenKind(rec);
  if (!kind) {
    return { breakEvenSource: 'No break-even on file: no weekly running cost and no model break-even that clears the quality floor.', breakEvenQuality: 'unavailable' };
  }
  const cost = isPositive(rec.weeklyRunningCost) ? rec.weeklyRunningCost : null;
  const reported = cost != null && costIsCitedReported(rec);
  const REPORTED_METHODS = ['trade-reported', 'sec-filing', 'producer-confirmed'];
  // A reported methodology whose citation is not a printable press/SEC/producer source counts as an estimate (Wanted, 2026-11).
  const label = !reported && REPORTED_METHODS.includes(rec.costMethodology)
    ? `marked ${METHODOLOGY_LABEL[rec.costMethodology]}, but ${rec.weeklyRunningCostSource ? 'the cited source is an estimate' : 'no citation is on file'}`
    : METHODOLOGY_LABEL[rec.costMethodology] || 'unattributed estimate';
  const costPart = cost == null
    ? null
    : reported
      ? `the reported weekly ${rec.weeklyRunningCostBasis === 'breakeven' ? 'break-even' : rec.weeklyRunningCostBasis === 'all-in' ? 'operating expense' : 'running cost'} (weeklyRunningCost; ${label}, citation in weeklyRunningCostSource)`
      : `an estimated weekly running cost (weeklyRunningCost; ${label}${rec.weeklyRunningCostSource ? '; see weeklyRunningCostSource' : label.includes('citation') ? '' : ', no citation'})`;
  if (kind === 'cost') {
    return { breakEvenSource: `Break-even is ${costPart}.`, breakEvenQuality: reported ? 'reported' : 'estimated' };
  }
  if (costPart) {
    const adds = rec.weeklyRunningCostBasis === 'breakeven' || rec.weeklyRunningCostBasis === 'all-in' ? '' : '; cost plus royalties and rent';
    return { breakEvenSource: `Model break-even (modelBreakeven${adds}) built on ${costPart}.`, breakEvenQuality: reported ? 'reported' : 'estimated' };
  }
  const basis = (rec.modelInputBasis || []).find((b) => b.input === 'weeklyRunningCost')?.basis;
  const why = basis === 'comparables' ? 'a weekly cost estimated from similar shows' : 'the model\'s default weekly cost for its show type, era and house size';
  return { breakEvenSource: `Model break-even (modelBreakeven) on ${why}; no weekly cost on file.`, breakEvenQuality: 'estimated' };
}

/** Sets the two fields on the record; true when either changed. */
function stampBreakEvenProvenance(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const next = breakEvenProvenance(rec);
  const changed = rec.breakEvenSource !== next.breakEvenSource || rec.breakEvenQuality !== next.breakEvenQuality;
  rec.breakEvenSource = next.breakEvenSource;
  rec.breakEvenQuality = next.breakEvenQuality;
  return changed;
}

/** Problems with stored provenance fields (absent fields and stale-but-valid values are not a problem). */
function breakEvenProvenanceErrors(showId, rec) {
  const out = [];
  if (rec.breakEvenQuality == null && rec.breakEvenSource == null) return out;
  if (!BREAK_EVEN_QUALITIES.includes(rec.breakEvenQuality)) {
    out.push(`commercial.json: "${showId}" has invalid breakEvenQuality ${JSON.stringify(rec.breakEvenQuality)}. Valid values: ${BREAK_EVEN_QUALITIES.join(', ')}`);
    return out;
  }
  // A stored quality that no longer matches the cost fields is NOT an error here: writers merge new cost
  // fields into a stamped record and validate before the write guard re-stamps it (it overwrites both
  // fields on every save), so a mismatch only means the record is about to be re-derived.
  if (typeof rec.breakEvenSource !== 'string' || !rec.breakEvenSource.trim()) {
    out.push(`commercial.json: "${showId}" has breakEvenQuality but no breakEvenSource`);
  }
  return out;
}

module.exports = {
  BREAK_EVEN_QUALITIES,
  displayedBreakEvenKind,
  breakEvenProvenance,
  stampBreakEvenProvenance,
  breakEvenProvenanceErrors,
};
