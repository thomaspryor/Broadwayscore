'use strict';

/**
 * cost-history.js — dated weekly cost anchors per show (BRO-4989).
 *
 * A single `weeklyRunningCost` number cannot say WHEN it was true: Wicked's
 * ~$800K was a 2008 figure, but the recoupment model applied it to every week
 * from 2003 to today. `costHistory` keeps every figure we have, each with the
 * date it describes and how good its source is:
 *
 *   costHistory: [{ asOf: 'YYYY-MM-DD', amount, kind: 'running-cost'|'break-even',
 *                   sourceType, sourceUrl, note, postId?, dateBasis? }]
 *
 * SHADOW-FIRST: costHistory sits beside weeklyRunningCost. Nothing on the live
 * site reads it until a separate, flagged switch. weeklyRunningCost stays the
 * derived current value.
 *
 * Pure: no I/O. costForWeek() lives in cost-for-week.js.
 */

const ANCHOR_KINDS = new Set(['running-cost', 'break-even']);

/**
 * Source tiers, best first. The half-width is the +/- fraction of the range
 * an anchor carries on the date it describes (a producer's own figure is close
 * to exact; our own estimate is a guess). Distance from the anchor widens it
 * further (cost-for-week.js).
 */
const SOURCE_TIERS = {
  'producer-confirmed': { rank: 0, halfWidth: 0.05 },
  sec: { rank: 1, halfWidth: 0.07 },
  trade: { rank: 2, halfWidth: 0.10 },
  'reddit-standard': { rank: 3, halfWidth: 0.15 },
  'industry-estimate': { rank: 4, halfWidth: 0.25 },
};
const SOURCE_TYPES = new Set(Object.keys(SOURCE_TIERS));

// commercial.json costMethodology -> anchor sourceType. Anything unnamed is our
// own estimate: an unnamed method never earns a reported tier.
const SOURCE_TYPE_BY_METHODOLOGY = {
  'producer-confirmed': 'producer-confirmed',
  'sec-filing': 'sec',
  'trade-reported': 'trade',
  'reddit-standard': 'reddit-standard',
  'industry-estimate': 'industry-estimate',
  'deep-research': 'industry-estimate',
};

const MIN_ANCHOR_AMOUNT = 100_000;
const MAX_ANCHOR_AMOUNT = 5_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sourceTypeForMethodology(methodology) {
  return SOURCE_TYPE_BY_METHODOLOGY[methodology] || 'industry-estimate';
}

/** Problems with one anchor; empty when it is usable. */
function anchorErrors(anchor) {
  const errs = [];
  if (!anchor || typeof anchor !== 'object') return ['not an object'];
  if (!isRealDate(anchor.asOf)) {
    errs.push(`asOf must be YYYY-MM-DD (got ${JSON.stringify(anchor.asOf)})`);
  }
  if (!Number.isFinite(anchor.amount) || anchor.amount < MIN_ANCHOR_AMOUNT || anchor.amount > MAX_ANCHOR_AMOUNT) {
    errs.push(`amount ${anchor.amount} outside $${MIN_ANCHOR_AMOUNT.toLocaleString()}-$${MAX_ANCHOR_AMOUNT.toLocaleString()}`);
  }
  if (!ANCHOR_KINDS.has(anchor.kind)) errs.push(`kind must be running-cost|break-even (got ${anchor.kind})`);
  if (!SOURCE_TYPES.has(anchor.sourceType)) errs.push(`sourceType must be one of ${[...SOURCE_TYPES].join('/')} (got ${anchor.sourceType})`);
  if (anchor.sourceType !== 'industry-estimate' && !(typeof anchor.sourceUrl === 'string' && /^https?:\/\//.test(anchor.sourceUrl))
      && anchor.dateBasis !== 'migrated') {
    errs.push(`a ${anchor.sourceType} anchor needs a sourceUrl`);
  }
  if (anchor.bound !== undefined && anchor.bound !== 'min') errs.push(`bound must be 'min' when set (got ${anchor.bound})`);
  return errs;
}

/**
 * Costs history for a record that has no costHistory yet: its migrated
 * weeklyRunningCost plus researched seed anchors (data/cost-anchor-seeds.json).
 * When a seed carries the same running-cost figure as the legacy field
 * (within 0.5%), the legacy copy is dropped: it is the same report, and the
 * seed knows its real date (Hamilton's $643K is a 2017 figure, not 2025).
 * A record that already has costHistory is returned as is.
 */
function historyWithSeeds(record, show, seeds = []) {
  // Malformed anchors are dropped here (check-cost-anchors.js reports them),
  // so one bad row can never stop the model.
  if (Array.isArray(record?.costHistory) && record.costHistory.length) return record.costHistory.filter((a) => anchorErrors(a).length === 0);
  const legacy = legacyCostAnchor(record || {}, show);
  const sameFigure = legacy && seeds.some((a) => a.kind === 'running-cost' && Math.abs(a.amount / legacy.amount - 1) <= 0.005);
  const base = legacy && !sameFigure ? [legacy] : [];
  return addAnchors(base, seeds).history;
}

/**
 * Identity for dedup. A Reddit post is keyed by its post id, so the same post
 * read twice adds one anchor however its text was parsed; everything else by
 * kind + date + amount + source.
 */
function anchorKey(anchor) {
  if (anchor.postId) return `post:${anchor.postId}:${anchor.kind}`;
  return `${anchor.kind}|${anchor.asOf}|${Math.round(anchor.amount)}|${anchor.sourceUrl || anchor.sourceType}`;
}

/**
 * Merge new anchors into a history. Invalid anchors are refused (returned
 * with their reasons), duplicates are skipped, and the result is sorted by
 * date. Never mutates its inputs.
 * @returns {{ history: object[], added: object[], duplicates: number, refused: {anchor, errors}[] }}
 */
function addAnchors(history, anchors) {
  const out = Array.isArray(history) ? history.slice() : [];
  const seen = new Set(out.map(anchorKey));
  const added = [];
  const refused = [];
  let duplicates = 0;
  for (const a of anchors || []) {
    const errors = anchorErrors(a);
    if (errors.length) { refused.push({ anchor: a, errors }); continue; }
    const key = anchorKey(a);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    out.push(a);
    added.push(a);
  }
  out.sort((x, y) => x.asOf.localeCompare(y.asOf) || anchorKey(x).localeCompare(anchorKey(y)));
  return { history: out, added, duplicates, refused };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** A real calendar date (rejects 2024-02-30, which Date.parse rolls into March). */
function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// Whole month words only: "Dec" or "December", never "Decision".
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_PATTERNS = [
  { re: /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/, out: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2}),?\\s+((?:19|20)\\d{2})\\b`, 'i'), out: (m) => `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}` },
  { re: new RegExp(`\\b${MONTH}\\s+((?:19|20)\\d{2})\\b`, 'i'), out: (m) => `${m[2]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-15` },
];
const pad = (n) => String(n).padStart(2, '0');

/** Earliest "YYYY-MM-DD" / "Mon D, YYYY" / "Month YYYY" date in free text, as YYYY-MM-DD; null when none. */
function dateFromText(text) {
  if (typeof text !== 'string') return null;
  let best = null;
  for (const p of DATE_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    if (best && m.index >= best.index) continue;
    const d = p.out(m);
    if (isRealDate(d)) best = { index: m.index, d };
  }
  return best ? best.d : null;
}

/**
 * The anchor today's single weeklyRunningCost stands for, with the best date
 * we can give it:
 *  1. a date written in weeklyRunningCostSource ("Broadway Journal (Dec 16, 2025)")  dateBasis 'source-text'
 *  2. the newest sources[] entry of a matching type with a date                        dateBasis 'sources'
 *  3. the record's lastUpdated / firstAdded                                             dateBasis 'record-updated'
 * A closed show's figure is never dated after its closing date (it describes
 * the run). Our own estimates are 2025-calibrated (recoupment-model.js
 * ERA_ANCHOR_YEAR), so an industry estimate with no better date gets 2025-07-01.
 *
 * modelBreakeven is NOT migrated: it is computed from weeklyRunningCost, so a
 * break-even anchor made from it would count the same figure twice.
 *
 * @returns {object|null}
 */
function legacyCostAnchor(record, show) {
  const amount = record?.weeklyRunningCost;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const sourceType = sourceTypeForMethodology(record.costMethodology);

  let asOf = dateFromText(record.weeklyRunningCostSource);
  let dateBasis = asOf ? 'source-text' : null;
  const wanted = { trade: 'trade', sec: 'sec', 'producer-confirmed': 'producer' }[sourceType];
  let sourceUrl = null;
  const srcs = Array.isArray(record.sources) ? record.sources : [];
  const match = srcs
    .filter((s) => s && (!wanted || s.type === wanted) && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  if (match) sourceUrl = match.url;
  if (!asOf && wanted && match && typeof match.date === 'string' && DATE_RE.test(match.date)) {
    asOf = match.date;
    dateBasis = 'sources';
  }
  if (!asOf && sourceType === 'industry-estimate') {
    asOf = '2025-07-01';
    dateBasis = 'estimate-calibration-year';
  }
  if (!asOf) {
    const d = String(record.lastUpdated || record.firstAdded || '').slice(0, 10);
    if (DATE_RE.test(d)) { asOf = d; dateBasis = 'record-updated'; }
  }
  if (!asOf) { asOf = '2025-07-01'; dateBasis = 'record-updated'; }
  if (show?.closingDate && DATE_RE.test(String(show.closingDate).slice(0, 10)) && asOf > String(show.closingDate).slice(0, 10)) {
    asOf = String(show.closingDate).slice(0, 10);
    dateBasis += '+capped-at-closing';
  }
  if (show?.openingDate && DATE_RE.test(String(show.openingDate).slice(0, 10)) && asOf < String(show.openingDate).slice(0, 10)) {
    asOf = String(show.openingDate).slice(0, 10);
    dateBasis += '+floored-at-opening';
  }

  const anchor = {
    asOf,
    amount: Math.round(amount),
    kind: 'running-cost',
    sourceType,
    sourceUrl,
    note: `migrated from weeklyRunningCost (${record.costMethodology || 'no method'})`,
    dateBasis: 'migrated',
    dateFrom: dateBasis,
  };
  return anchor;
}

/** Newest anchor of a kind (default running-cost), or null. */
function newestAnchor(history, kind = 'running-cost') {
  const list = (history || []).filter((a) => a.kind === kind);
  return list.length ? list[list.length - 1] : null;
}

module.exports = {
  ANCHOR_KINDS,
  SOURCE_TIERS,
  SOURCE_TYPES,
  sourceTypeForMethodology,
  anchorErrors,
  anchorKey,
  addAnchors,
  dateFromText,
  isRealDate,
  legacyCostAnchor,
  historyWithSeeds,
  newestAnchor,
};
