'use strict';

// BRO-5018: research evidence for the cost index, never model inputs.
const fs = require('fs');
const path = require('path');
const { carry } = require('./cost-for-week');
const { median, MAX_MEDIAN_ERROR } = require('./cost-index-backtest');

const ERAS = ['pre-2010', '2010-2019', '2020+'];
const MIN_PAIRS_PER_ERA = 10;
const SOURCE_TYPES = new Set(['trade', 'producer-confirmed', 'sec']);
const LEDGER_PATH = path.join(__dirname, '../../data/cost-anchor-ledger.json');

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function eraFor(asOf) {
  return asOf < '2010-01-01' ? ERAS[0] : asOf < '2020-01-01' ? ERAS[1] : ERAS[2];
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sourceErrors(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return ['source must be an object'];
  const errors = [];
  if (!SOURCE_TYPES.has(source.sourceType)) errors.push('sourceType must be trade, producer-confirmed or sec');
  if (!text(source.publisher)) errors.push('publisher is required');
  if (!text(source.note)) errors.push('note must explain the figure and its cost date');
  if (!isDate(source.reportedAt)) errors.push('reportedAt must be a calendar date');
  if (source.sourceType === 'producer-confirmed' && !text(source.confirmedBy)) errors.push('confirmedBy is required');
  try {
    const url = new URL(source.url);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || !host || url.username || url.password) errors.push('url must be a public HTTP(S) URL');
    // Check publisher identity only. Cost dates and amounts never come from URLs.
    if (host === 'redd.it' || /(^|\.)reddit\.com$/.test(host) || host === 'forum.broadwayworld.com') errors.push('forums and Reddit never qualify');
    if (source.sourceType === 'sec' && host !== 'sec.gov' && !host.endsWith('.sec.gov')) errors.push('sec sources must link to sec.gov');
  } catch { errors.push('url must be a public HTTP(S) URL'); }
  return errors;
}

/** Validate evidence separately from coverage so an unfinished ledger can be maintained honestly. */
function validateLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.pairs)) return ['pairs must be an array'];
  const errors = [];
  const seen = new Set();
  ledger.pairs.forEach((pair, i) => {
    const prefix = `pairs[${i}]`;
    const bad = (message) => errors.push(`${prefix}: ${message}`);
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) { bad('pair must be an object'); return; }
    if (!text(pair.show)) bad('show must identify one production');
    if (!['running-cost', 'capitalization'].includes(pair.kind)) bad('kind must be running-cost or capitalization');
    if (pair.currency !== 'USD') bad('currency must be USD');
    if (!text(pair.costBasis)) bad('costBasis must describe the comparable amounts');
    if (!ERAS.includes(pair.era)) bad('unknown era');
    for (const side of ['A', 'B']) {
      const asOf = pair[`asOf${side}`];
      if (!isDate(asOf)) bad(`asOf${side} must be a calendar date`);
      if (!(Number.isFinite(pair[`amount${side}`]) && pair[`amount${side}`] > 0)) bad(`amount${side} must be positive and finite`);
      if (pair[`bound${side}`] != null) bad(`bound${side}: a bound is not a point observation`);
      const source = pair[`source${side}`];
      for (const error of sourceErrors(source)) bad(`source${side}: ${error}`);
      if (isDate(asOf) && isDate(source?.reportedAt) && asOf > source.reportedAt) bad(`asOf${side} cannot be later than its report`);
      if (!['reported-current', 'period-midpoint', 'period-end'].includes(source?.dateBasis)) bad(`source${side}: dateBasis is required`);
    }
    if (isDate(pair.asOfA) && isDate(pair.asOfB)) {
      if (pair.asOfA >= pair.asOfB) bad('asOfA must precede asOfB');
      // A cross-era pair belongs only to its starting era, never to both.
      if (pair.era !== eraFor(pair.asOfA)) bad('era must match asOfA');
    }
    const key = JSON.stringify([pair.show, pair.kind, pair.costBasis, pair.asOfA, pair.asOfB]);
    if (seen.has(key)) bad('duplicate production/cost-basis/date pair');
    seen.add(key);
  });
  return errors;
}

function evaluateLedger(ledger) {
  const errors = validateLedger(ledger);
  if (errors.length) throw new Error(`Invalid cost-anchor ledger:\n${errors.join('\n')}`);
  const pairs = ledger.pairs.map((pair) => {
    const predicted = carry(pair.amountA, pair.asOfA, pair.asOfB);
    return { show: pair.show, era: pair.era, kind: pair.kind, asOfA: pair.asOfA, asOfB: pair.asOfB,
      amountA: pair.amountA, amountB: pair.amountB, predicted: Math.round(predicted), error: predicted / pair.amountB - 1 };
  });
  const byEra = Object.fromEntries(ERAS.map((era) => {
    const rows = pairs.filter((pair) => pair.era === era);
    return [era, { pairs: rows.length, missing: Math.max(0, MIN_PAIRS_PER_ERA - rows.length),
      medianAbsError: median(rows.map((pair) => Math.abs(pair.error))),
      byKind: Object.fromEntries(['running-cost', 'capitalization'].map((kind) => {
        const selected = rows.filter((pair) => pair.kind === kind);
        return [kind, { pairs: selected.length, medianAbsError: median(selected.map((pair) => Math.abs(pair.error))) }];
      })) }];
  }));
  const indexPass = ERAS.every((era) => byEra[era].medianAbsError !== null && byEra[era].medianAbsError <= MAX_MEDIAN_ERROR);
  return { minimumPerEra: MIN_PAIRS_PER_ERA, coverageReady: ERAS.every((era) => byEra[era].missing === 0), indexPass,
    byEra, pairs, medianAbsError: median(pairs.map((pair) => Math.abs(pair.error))) };
}

function loadLedger() {
  // Missing or malformed evidence must be visible, never silently replaced with estimates.
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

module.exports = { validateLedger, evaluateLedger, loadLedger, ERAS, MIN_PAIRS_PER_ERA };
