'use strict';

/**
 * BRO-5677: a capitalization tagged 'maximum' is a Form D offering ceiling
 * ("capitalized for up to $X"), not the amount raised. opts.capMaxHaircut in
 * recoupment-model.js scales such a figure by CAP_MAX_HAIRCUT, the median
 * raise-to-ceiling ratio over records that state both numbers.
 *
 * Fit (2026-10-19, commercial.json): 20 pairs, median 0.95 (range 0.69-1.0;
 * 7 offerings fully sold and one at 0.999). Several pairs are interim Form D/A amendments
 * ("$X sold by then"), so the true ratio is, if anything, nearer 1.
 * Shadow only: the timing backtest did not improve with it (see BRO-5677).
 */

const { isMaximumCapitalization } = require('./public-source-text');

const CAP_MAX_HAIRCUT = 0.95;
const MIN_PAIRS = 8;

const num = (s) => Number(String(s).replace(/,/g, ''));
// The offering ceiling a source's wording states, else null.
const CEILING_RES = [
  /total offering amount (?:of )?\$([\d,]+)/i,
  /\$([\d,]+) offering\b/i,
  /maximum capitali[sz]ation was \$([\d,]+)/i,
  /offering of up to \$([\d,]+)/i,
];
const FULLY_SOLD_RE = /\bfully sold\b|\ball of it sold\b/i;

function ceilingFromText(text) {
  for (const re of CEILING_RES) {
    const m = (text || '').match(re);
    if (m && num(m[1]) > 0) return num(m[1]);
  }
  return null;
}

/**
 * One raise-to-ceiling pair from a commercial record, else null:
 * a 'maximum' record with a reported capitalActual, or a 'sold'/'reported'
 * record whose source also states the offering ceiling (or says fully sold).
 * @param {object} rec commercial.json record
 * @returns {{ raised: number, ceiling: number, ratio: number } | null}
 */
function raiseCeilingPair(rec) {
  if (!rec || !(rec.capitalization > 0)) return null;
  let raised;
  let ceiling;
  if (isMaximumCapitalization(rec)) {
    if (!(rec.capitalActual > 0)) return null;
    raised = rec.capitalActual;
    ceiling = rec.capitalization;
  } else if (['sold', 'reported'].includes(rec.capitalizationBasis)) {
    raised = rec.capitalActual > 0 ? rec.capitalActual : rec.capitalization;
    ceiling = ceilingFromText(rec.capitalizationSource) || (FULLY_SOLD_RE.test(rec.capitalizationSource || '') ? raised : null);
  } else {
    return null;
  }
  if (!ceiling || raised > ceiling) return null;
  return { raised, ceiling, ratio: raised / ceiling };
}

/**
 * The median raise-to-ceiling ratio over a set of commercial records, or a
 * null factor when fewer than MIN_PAIRS pairs exist.
 * @param {Record<string, object>} shows commercial.json .shows
 * @returns {{ factor: number | null, n: number, pairs: Array<{ slug: string, ratio: number }> }}
 */
function fitCapMaxHaircut(shows) {
  const pairs = Object.entries(shows || {})
    .map(([slug, rec]) => ({ slug, pair: raiseCeilingPair(rec) }))
    .filter((x) => x.pair)
    .map(({ slug, pair }) => ({ slug, ratio: pair.ratio }));
  if (pairs.length < MIN_PAIRS) return { factor: null, n: pairs.length, pairs };
  const r = pairs.map((p) => p.ratio).sort((a, b) => a - b);
  const mid = Math.floor(r.length / 2);
  const factor = r.length % 2 ? r[mid] : (r[mid - 1] + r[mid]) / 2;
  return { factor, n: pairs.length, pairs };
}

/**
 * The capitalization the model should use. opts.capMaxHaircut: true uses
 * CAP_MAX_HAIRCUT, a number in (0, 1] uses that factor; anything else, or a
 * figure not tagged as a ceiling, returns the record's capitalization as is.
 * @returns {{ capitalization: number | null | undefined, factor: number | null }}
 */
function haircutCapitalization(commercial, opt) {
  const cap = commercial && commercial.capitalization;
  const factor = opt === true ? CAP_MAX_HAIRCUT : typeof opt === 'number' && opt > 0 && opt <= 1 ? opt : null;
  if (!factor || !cap || !isMaximumCapitalization(commercial)) return { capitalization: cap, factor: null };
  return { capitalization: cap * factor, factor };
}

module.exports = { CAP_MAX_HAIRCUT, MIN_PAIRS, ceilingFromText, raiseCeilingPair, fitCapMaxHaircut, haircutCapitalization };
