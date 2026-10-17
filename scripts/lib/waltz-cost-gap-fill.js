/**
 * What u/Boring_Waltz_9545's r/Broadway weekly operating cost estimates may
 * write to data/commercial.json (owner decision 2026-10-05, BRO-4666).
 *
 * His figures fill a missing weekly cost and replace our own estimates
 * (industry-estimate, deep-research): his are per-show analyses he publishes
 * and revises every week. They never replace a reported figure (trade press,
 * SEC filing, producer), and never a cost whose source the record does not
 * name. Every value he supplies is flagged as an estimate, so /biz prints it
 * with "~" and the "Estimate" source line.
 *
 * update-commercial-data.js applies the same rule to its model-proposed
 * costs: isReportedWeeklyCost() plus the source-basis helpers below.
 *
 * Pure: no I/O.
 */

const { internalWordingIn } = require('./commercial-record-checks');

// costMethodology values that mean the weekly cost was reported, not estimated.
const REPORTED_COST_METHODOLOGIES = new Set(['trade-reported', 'sec-filing', 'producer-confirmed']);
// Our own estimates, which his per-show figures replace.
const OUR_ESTIMATE_METHODOLOGIES = new Set(['industry-estimate', 'deep-research']);
const WALTZ_METHODOLOGY = 'reddit-standard';
// His own earlier figure is refreshed only when the new one moves more than this.
const REFRESH_THRESHOLD = 0.10;
// A Broadway weekly running cost outside this range is a misread, not a
// figure ("$1 million/week" once parsed as $1).
const MIN_WEEKLY_COST = 100_000;
const MAX_WEEKLY_COST = 5_000_000;

/** True for a dollar figure inside the plausible Broadway weekly-cost range. */
function isPlausibleWeeklyCost(cost) {
  return Number.isFinite(cost) && cost >= MIN_WEEKLY_COST && cost <= MAX_WEEKLY_COST;
}

/** True when the record's weekly cost is a reported figure an estimate must never overwrite. */
function isReportedWeeklyCost(record) {
  return record?.weeklyRunningCost != null && REPORTED_COST_METHODOLOGIES.has(record.costMethodology);
}

// update-commercial-data.js sends the model its context in lettered sections:
// A current data, B box-office math, C his grosses post, D its comments,
// E other Reddit threads, F trade press, G shows without data, H SEC Form D
// filings. The model writes sources as "Section X: ..." or "Sections C and F:
// ...", so "reddit" alone missed most of his figures, and a substring test
// for "sec" matched every "Section".
const REDDIT_SECTIONS = new Set(['C', 'D', 'E']);
const REPORTED_SECTIONS = new Set(['F', 'H']);
// "Section C", "Sections C, D and F", "Sections F/H", "Sections C-E". The
// letters are capitals only, so prose after a section ("Section F, e.g.
// Deadline", "Section F - a Variety piece") adds no sections.
const SECTION_LIST_RE = /\b[Ss]ections?\s*\(?\s*([A-H](?:\s*(?:,|&|\band\b|\bor\b|\/|-|–)\s*[A-H])*)\b/g;
const SECTION_RANGE_RE = /\b([A-H])\s*[-–]\s*([A-H])\b/g;
const SECTION_SEPARATOR_RE = /\s*(?:,|&|\band\b|\bor\b|\/|-|–)\s*/;
const REDDIT_SOURCE_RE = /\breddit\b|\br\/broadway\b|\bu\/|grosses\s+analysis|boring[\s_]*waltz/i;
const SEC_SOURCE_RE = /\bsec\b|\bform\s*d\b|\bedgar\b/i;
const TRADE_SOURCE_RE = /\bdeadline\b|\bvariety\b|broadway\s+news|broadway\s+journal|new\s+york\s+times|\bnyt\b|hollywood\s+reporter|\bforbes\b|\bplaybill\b|theatermania|broadwayworld|wall\s+street\s+journal/i;

/** The context-section letters a source cites, upper case ("Sections C-E" gives C, D, E). */
function citedSections(source) {
  const letters = new Set();
  if (typeof source !== 'string') return letters;
  for (const m of source.matchAll(SECTION_LIST_RE)) {
    const list = m[1].replace(SECTION_RANGE_RE, (_, a, b) => {
      const [lo, hi] = [a.charCodeAt(0), b.charCodeAt(0)].sort((x, y) => x - y);
      return Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCharCode(lo + i)).join(',');
    });
    for (const letter of list.split(SECTION_SEPARATOR_RE)) letters.add(letter.trim());
  }
  return letters;
}

/**
 * What a model-proposed figure's source text says it rests on: 'reddit',
 * 'sec', 'trade', or null when it names nothing (the model's own inference).
 * Reddit wins when a source mentions it at all, so a mixed source counts as
 * an estimate. A source citing sections counts as reported only when every
 * section it cites is trade press (F) or an SEC filing (H): our own data (A),
 * box-office math (B) or the no-data list (G) beside them is inference.
 */
function costSourceBasis(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  const sections = citedSections(source);
  if (REDDIT_SOURCE_RE.test(source) || [...sections].some((s) => REDDIT_SECTIONS.has(s))) return 'reddit';
  if (sections.size > 0) {
    if (![...sections].every((s) => REPORTED_SECTIONS.has(s))) return null;
    return sections.has('H') ? 'sec' : 'trade';
  }
  if (SEC_SOURCE_RE.test(source)) return 'sec';
  if (TRADE_SOURCE_RE.test(source)) return 'trade';
  return null;
}

const METHODOLOGY_BY_BASIS = { reddit: WALTZ_METHODOLOGY, sec: 'sec-filing', trade: 'trade-reported' };

/** costMethodology for a cost whose source text reads this way; our own estimate when it names nothing. */
function methodologyForCostSource(source) {
  const basis = costSourceBasis(source);
  return basis ? METHODOLOGY_BY_BASIS[basis] : 'industry-estimate';
}

/**
 * True when a model-proposed figure rests on trade press or an SEC filing.
 * Only such a figure may replace a reported one, or keep a citation and print
 * as reported; anything else is an estimate.
 */
function isReportedSource(source) {
  return REPORTED_COST_METHODOLOGIES.has(methodologyForCostSource(source));
}

// Research-tooling wording src/lib/commercial-display.ts publicSourceText()
// also refuses to print as a source.
const INTERNAL_COST_SOURCE_RE = /(?:chat)?gpt|deep[\s-]*research|\bDR\s*batch\b|\bconsensus\b|\binferred\b|industry[\s-]*estimate/i;

/**
 * A citation the weekly update may store beside a figure it labels reported:
 * it names trade press or an SEC filing, and reads as a citation (no context
 * section letters, no research-tooling wording).
 */
function isPrintableReportedCitation(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return citedSections(text).size === 0 && isReportedSource(text)
    && !INTERNAL_COST_SOURCE_RE.test(text) && !internalWordingIn(text);
}

/**
 * A reported weekly cost that names a printable source. /biz shows any other
 * cost as an estimate (isEstimatedRunningCost), so the recoupment model
 * grades only this as high-quality input.
 */
function isCitedReportedWeeklyCost(record) {
  if (!isReportedWeeklyCost(record) || record.isEstimate?.weeklyRunningCost === true) return false;
  const source = typeof record.weeklyRunningCostSource === 'string' ? record.weeklyRunningCostSource.trim() : '';
  return source !== '' && costSourceBasis(source) !== 'reddit' && !INTERNAL_COST_SOURCE_RE.test(source);
}

/**
 * @param {object|undefined} record - the commercial.json record
 * @param {number} cost - his weekly operating cost estimate, in dollars
 * @returns {{ write: boolean, reason: string }}
 */
function decideWaltzCostWrite(record, cost) {
  if (!record) return { write: false, reason: 'no commercial record' };
  if (!(Number.isFinite(cost) && cost > 0)) return { write: false, reason: 'no usable cost' };
  if (!isPlausibleWeeklyCost(cost)) {
    return { write: false, reason: `implausible weekly cost $${cost.toLocaleString()}` };
  }
  const current = record.weeklyRunningCost;
  if (current == null) return { write: true, reason: 'fills a missing weekly cost' };
  const method = record.costMethodology;
  if (isReportedWeeklyCost(record)) return { write: false, reason: `keeps the reported figure (${method})` };
  if (OUR_ESTIMATE_METHODOLOGIES.has(method)) return { write: true, reason: `replaces our ${method}` };
  if (method === WALTZ_METHODOLOGY) {
    const diff = Math.abs(current - cost) / current;
    return diff > REFRESH_THRESHOLD
      ? { write: true, reason: `his newer figure moved ${(diff * 100).toFixed(1)}%` }
      : { write: false, reason: 'within 10% of his last figure' };
  }
  return { write: false, reason: `keeps a cost with no named method (${method || 'none'})` };
}

/**
 * The fields to set on a record decideWaltzCostWrite() allows.
 * @param {object} record
 * @param {{ cost: number, postTitle: string, postDate: string, permalink?: string }} post
 * @param {Date} [now]
 */
function waltzCostPatch(record, { cost, postTitle, postDate, permalink }, now = new Date()) {
  const url = permalink ? ` https://www.reddit.com${permalink}` : '';
  return {
    weeklyRunningCost: cost,
    costMethodology: WALTZ_METHODOLOGY,
    isEstimate: { ...(record.isEstimate || {}), weeklyRunningCost: true },
    weeklyRunningCostSource: `Estimate by u/Boring_Waltz_9545 on r/Broadway, "${postTitle}" (${postDate})${url}`,
    lastUpdated: now.toISOString(),
  };
}

module.exports = {
  decideWaltzCostWrite,
  waltzCostPatch,
  isPlausibleWeeklyCost,
  isReportedWeeklyCost,
  citedSections,
  costSourceBasis,
  methodologyForCostSource,
  isReportedSource,
  isPrintableReportedCitation,
  isCitedReportedWeeklyCost,
  REPORTED_COST_METHODOLOGIES,
  OUR_ESTIMATE_METHODOLOGIES,
  WALTZ_METHODOLOGY,
};
