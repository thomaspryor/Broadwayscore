'use strict';

/**
 * commercial-leads.js — guess-grade figures for the recoupment model (BRO-5849).
 *
 * Owner intent (2026-10-21): "the intent of this is to GUESS, since otherwise
 * we have NO IDEA." A record may carry `leads`: figures that are not
 * disclosed facts (a Reddit estimate, an SEC offering ceiling filed by an
 * inferred issuer, a press projection, a floor, a joint budget). The model
 * reads a lead only when the record has no fact for that input, widens its
 * range by how far the lead can be trusted, and marks the run
 * 'estimate-based'. The site prints a lead as "~ Estimated" with its source;
 * a lead is never a disclosed figure, never in a disclosed count or sum.
 *
 *   leads: [{
 *     kind: 'capitalization' | 'weeklyRunningCost' | 'breakeven' | 'percentReturned',
 *     value | (low + high),              // dollars; percentReturned is a percent
 *     sourceClass: 'qualified' | 'press-projection' | 'sec-ceiling-inferred-issuer'
 *                | 'reddit' | 'joint' | 'floor',
 *     confidence: 'low' | 'medium',
 *     source: { quote, url },            // public: no reader names, no owner figures
 *     date: 'YYYY-MM-DD',
 *   }]
 *
 * Only capitalization and weeklyRunningCost feed the model. breakeven and
 * percentReturned are display and backtest truth.
 */

const LEAD_KINDS = Object.freeze(['capitalization', 'weeklyRunningCost', 'breakeven', 'percentReturned']);
/** Kinds the model can use in place of a missing fact. */
const MODEL_KINDS = Object.freeze(['capitalization', 'weeklyRunningCost']);
/** Best-trusted first. */
const SOURCE_CLASSES = Object.freeze(['qualified', 'press-projection', 'sec-ceiling-inferred-issuer', 'reddit', 'joint', 'floor']);
const CONFIDENCES = Object.freeze(['low', 'medium']);
const CLASS_RANK = Object.freeze(Object.fromEntries(SOURCE_CLASSES.map((c, i) => [c, SOURCE_CLASSES.length - i])));
const CONF_RANK = Object.freeze({ low: 0, medium: 1 });

/** Half-width of a single-value lead's range, by confidence. */
const SPREAD = Object.freeze({
  capitalization: { low: 0.3, medium: 0.15 },
  weeklyRunningCost: { low: 0.2, medium: 0.1 },
});
/**
 * Where inside the stated number the likely truth sits. A filed ceiling is
 * rarely fully raised, a floor is the least it can be, and a joint budget is
 * shared by two productions.
 */
const CLASS_SHAPE = Object.freeze({
  'sec-ceiling-inferred-issuer': { lo: 0.6, center: 0.8, hi: 1 },
  floor: { lo: 1, center: 1.2, hi: 1.5 },
  joint: { lo: 0.4, center: 0.6, hi: 0.8 },
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with one lead (strings), none when valid. Wording rules are the caller's (commercial-record-checks.js). */
function leadProblems(lead) {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return ['must be an object'];
  const out = [];
  if (!LEAD_KINDS.includes(lead.kind)) out.push(`kind must be one of ${LEAD_KINDS.join(', ')}`);
  if (!SOURCE_CLASSES.includes(lead.sourceClass)) out.push(`sourceClass must be one of ${SOURCE_CLASSES.join(', ')}`);
  if (!CONFIDENCES.includes(lead.confidence)) out.push(`confidence must be one of ${CONFIDENCES.join(', ')}`);
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const hasValue = lead.value != null;
  const hasRange = lead.low != null || lead.high != null;
  if (hasValue && hasRange) out.push('give value or low+high, not both');
  else if (hasValue) {
    if (!num(lead.value)) out.push('value must be a positive number');
  } else if (hasRange) {
    if (!num(lead.low) || !num(lead.high)) out.push('low and high must both be positive numbers');
    else if (lead.low > lead.high) out.push('low must not exceed high');
  } else out.push('needs value or low+high');
  if (lead.kind && lead.kind !== 'percentReturned' && num(lead.value) && lead.value < 1000) out.push('dollar figures are in whole dollars (value under 1000)');
  if (lead.kind === 'percentReturned' && [lead.value, lead.low, lead.high].some((v) => typeof v === 'number' && v > 1000)) out.push('percentReturned is a percent (value over 1000)');
  const src = lead.source;
  if (!src || typeof src !== 'object' || Array.isArray(src)) out.push('source must be { quote, url }');
  else {
    if (typeof src.quote !== 'string' || src.quote.trim().length < 8) out.push('source.quote must quote the source (8+ characters)');
    if (typeof src.url !== 'string' || !/^https:\/\/\S+$/.test(src.url)) out.push('source.url must be an https URL');
  }
  if (typeof lead.date !== 'string' || !DATE_RE.test(lead.date)) out.push('date must be YYYY-MM-DD');
  return out;
}

/** The lead's low / center / high, in the unit of its kind. */
function leadRange(lead) {
  const spread = (SPREAD[lead.kind] || SPREAD.capitalization)[lead.confidence] ?? 0.3;
  if (lead.value != null) {
    const shape = CLASS_SHAPE[lead.sourceClass];
    if (shape) return { low: lead.value * shape.lo, center: lead.value * shape.center, high: lead.value * shape.hi };
    return { low: lead.value * (1 - spread), center: lead.value, high: lead.value * (1 + spread) };
  }
  return { low: lead.low, center: (lead.low + lead.high) / 2, high: lead.high };
}

/** The most trusted lead of a kind: class, then confidence, then newest. Null when none. */
function pickLead(leads, kind) {
  if (!Array.isArray(leads)) return null;
  const pool = leads.filter((l) => l && l.kind === kind && leadProblems(l).length === 0);
  if (!pool.length) return null;
  pool.sort((a, b) => (CLASS_RANK[b.sourceClass] - CLASS_RANK[a.sourceClass])
    || (CONF_RANK[b.confidence] - CONF_RANK[a.confidence])
    || String(b.date).localeCompare(String(a.date)));
  return pool[0];
}

const FIELD_OF = Object.freeze({ capitalization: 'capitalization', weeklyRunningCost: 'weeklyRunningCost' });

/**
 * Which model inputs the record lacks that a lead can fill.
 * @returns {Array<{kind, field, lead, range}>}
 */
function leadFills(comm) {
  if (!comm || !Array.isArray(comm.leads)) return [];
  const fills = [];
  for (const kind of MODEL_KINDS) {
    const field = FIELD_OF[kind];
    if (comm[field]) continue; // a fact always wins
    const lead = pickLead(comm.leads, kind);
    if (lead) fills.push({ kind, field, lead, range: leadRange(lead) });
  }
  return fills;
}

/** A shallow copy of the record with each filled input set to `pick(fill)`. */
function withFills(comm, fills, pick) {
  const out = { ...comm };
  for (const f of fills) out[f.field] = Math.round(pick(f));
  return out;
}

/** The corner records for a range run: every low/high combination of the filled inputs. */
function cornerRecords(comm, fills) {
  const out = [];
  for (let mask = 0; mask < 1 << fills.length; mask++) {
    const bits = fills.map((_, i) => (mask >> i) & 1);
    const idx = new Map(fills.map((f, i) => [f, bits[i]]));
    out.push(withFills(comm, fills, (f) => (idx.get(f) ? f.range.high : f.range.low)));
  }
  return out;
}

/** What the record says about its lead-fed inputs, stored as modelLeadsUsed. */
function leadsUsedSummary(fills) {
  return fills.map(({ kind, lead, range }) => ({
    kind, sourceClass: lead.sourceClass, confidence: lead.confidence,
    low: Math.round(range.low), center: Math.round(range.center), high: Math.round(range.high),
  }));
}

/**
 * Run `run(record)` on a record, filling missing inputs from leads. With no
 * fill it is exactly `run(comm)`. With fills, the central result comes from
 * the lead centers and the low/high percentages widen to the extremes of the
 * range corners. dataQuality becomes 'estimate-based'.
 */
function runWithLeads(comm, run) {
  const fills = leadFills(comm);
  if (!fills.length) return run(comm);
  const mid = run(withFills(comm, fills, (f) => f.range.center));
  if (!mid || mid.error) return mid;
  const lows = [mid.recoupmentPctLow];
  const highs = [mid.recoupmentPctHigh];
  for (const rec of cornerRecords(comm, fills)) {
    const r = run(rec);
    if (!r || r.error) continue;
    lows.push(r.recoupmentPctLow);
    highs.push(r.recoupmentPctHigh);
  }
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  mid.recoupmentPctLow = Math.min(...lows.filter(num));
  mid.recoupmentPctHigh = Math.max(...highs.filter(num));
  mid.dataQuality = 'estimate-based';
  mid.leadInputs = leadsUsedSummary(fills);
  mid.warnings = [...(mid.warnings || []), ...fills.map((f) => `${f.field} is an estimate from a ${f.lead.sourceClass} lead (${f.lead.confidence} confidence): ~$${Math.round(f.range.center / 1000)}K`)];
  return mid;
}

/** The record as classifyTier should see it: lead-fillable inputs filled at their centers. */
function withLeadCenters(comm) {
  const fills = leadFills(comm);
  return fills.length ? withFills(comm, fills, (f) => f.range.center) : comm;
}

module.exports = { LEAD_KINDS, MODEL_KINDS, SOURCE_CLASSES, CONFIDENCES, leadProblems, leadRange, pickLead, leadFills, runWithLeads, withLeadCenters, leadsUsedSummary };
