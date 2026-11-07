'use strict';

// Star gross-participation deals, sourced only (BRO-5029, design approved by
// the BRO-4989 commercial checker 2026-10-11).
//
// commercial.json grossParticipation: [{ who, pct, basis: 'gross'|'grossAbove',
//   threshold?, weeklyGuarantee?, asOf, sourceType: 'trade'|'producer'|'sec',
//   sourceUrl }]
//   pct              percent of the weekly gross (10 = 10%)
//   basis            'gross' = share of the whole weekly gross;
//                    'grossAbove' = share of the gross above `threshold`
//   weeklyGuarantee  the weekly floor the star is paid against the percentage
//
// The model reads only entries a trade outlet, the producers or a filing
// stated, with an http(s) source. An entry missing either is ignored, never
// guessed at, and a star-driven show with no sourced entry is held ("star deal
// unknown") instead of getting a default premium.

const SOURCE_TYPES = new Set(['trade', 'producer', 'sec']);
const BASES = new Set(['gross', 'grossAbove']);

const finiteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Why an entry is not usable, or null when it is. */
function entryProblem(e) {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!SOURCE_TYPES.has(e.sourceType)) return `sourceType ${JSON.stringify(e.sourceType)} is not trade/producer/sec`;
  if (typeof e.sourceUrl !== 'string' || !/^https?:\/\/\S+$/.test(e.sourceUrl)) return 'no http(s) sourceUrl';
  if (!BASES.has(e.basis)) return `basis ${JSON.stringify(e.basis)} is not gross/grossAbove`;
  if (!(typeof e.pct === 'number' && Number.isFinite(e.pct) && e.pct > 0 && e.pct <= 100)) return 'pct is not in (0, 100]';
  if (e.basis === 'grossAbove' && !(finiteNonNeg(e.threshold) && e.threshold > 0)) return 'grossAbove needs a threshold';
  if (e.weeklyGuarantee != null && !finiteNonNeg(e.weeklyGuarantee)) return 'weeklyGuarantee is not a number >= 0';
  return null;
}

/**
 * The usable entries of a record's grossParticipation, and the ignored ones
 * with the reason.
 * @returns {{ entries: object[], ignored: { entry: any, reason: string }[] }}
 */
function sourcedGrossParticipation(commercial) {
  const list = commercial && Array.isArray(commercial.grossParticipation) ? commercial.grossParticipation : [];
  const entries = [];
  const ignored = [];
  for (const entry of list) {
    const reason = entryProblem(entry);
    if (reason) ignored.push({ entry, reason });
    else entries.push(entry);
  }
  return { entries, ignored };
}

/** One week's cost of the deals: each star gets the greater of the guarantee and the percentage. */
function weeklyParticipationCost(entries, weeklyGross) {
  const gross = Math.max(0, weeklyGross || 0);
  let cost = 0;
  for (const e of entries) {
    const base = e.basis === 'grossAbove' ? Math.max(0, gross - e.threshold) : gross;
    cost += Math.max(e.weeklyGuarantee || 0, base * e.pct / 100);
  }
  return cost;
}

/**
 * Held when the show is star-driven and no sourced deal covers it.
 * starDriven is the model's own star signal (a star-play category, or a slug
 * on the old unsourced star-deal list).
 */
function starDealUnknown({ starDriven, entries }) {
  return !!starDriven && !(entries && entries.length);
}

module.exports = { sourcedGrossParticipation, weeklyParticipationCost, starDealUnknown, entryProblem, SOURCE_TYPES };
