'use strict';

// Shadow cost split (BRO-5073, opts.costSplit). The live model treats the
// weekly running cost as fixed and adds 11-13% of gross for variable costs.
// The recoupment-timing backtest shows that is too generous when grosses run
// far above the cost (long-run musicals, star plays): royalties beyond the
// author's (designers, orchestrator, producer and office fees) and star
// percentages rise with gross. Under the split:
//
//   gross-linked  the category's live rate plus EXTRA_VARIABLE[category]
//   fixed         the reported cost, unless the record says that figure is
//                 all-in (royalties included, or the gross the show needs to
//                 break even): then the gross-linked share of it at that
//                 gross comes off, so royalties are not counted twice.
//
// "All-in" comes from an explicit weeklyRunningCostBasis field
// ('all-in' | 'running') or, without one, a cost source that says so in
// words ("all-in", "includes royalties"). Looser cues ("break even at")
// misfired on Stereophonic, so they are not used.
// Shadow only: live passes no opts.

const EXTRA_VARIABLE = {
  musical: 0.05,          // designers ~2%, orchestrator/music ~1%, producer + office ~2%
  musicalSpectacle: 0.05,
  // Plays: +2% (playStar +8%) moved more rows out of the band than into it
  // in the timing backtest (plays already read about right), so 0.
  play: 0,
  playStar: 0,
  special: 0,
};

const ALL_IN_TEXT = /\ball[- ]in\b|\bincludes?\s+(?:royalt|amortiz)/i;
// A cue that the figure includes gross-linked costs, or is a breakeven.
// Negated cues ("not all-in", "never broke even") and "all in all" are not.
const BASIS_CUE_TEXT = /(?<!\b(?:not|never|n't)\s+)(?:\ball[- ]in\b(?![- ]all\b)|\bincludes?\s+(?:royalt|amortiz)|\bbreak(?:s|ing)?[- ]?even\b)/i;
const RUNNING_TEXT = /\bexcl\w*\s+royalt|\bbefore royalt|\bpure operating\b/i;

/** 'all-in' | 'running' for the record's weekly cost figure. */
function costBasis(commercial) {
  const explicit = commercial && commercial.weeklyRunningCostBasis;
  if (explicit === 'all-in' || explicit === 'running') return explicit;
  if (explicit === 'breakeven') return 'all-in'; // gross-linked costs included (BRO-5093)
  const text = [commercial && commercial.weeklyRunningCostSource, commercial && commercial.notes].filter((v) => typeof v === 'string').join(' ');
  if (RUNNING_TEXT.test(text)) return 'running';
  return ALL_IN_TEXT.test(text) ? 'all-in' : 'running';
}

/**
 * @param {object} commercial
 * @param {string} category - classifyShow() output
 * @param {number} weeklyNut - the cost figure the model would use
 * @param {number} baseVarRate - the category's live variable rate
 * @param {number} theaterPct - theater share of gross (THEATER_DEAL.pctOfGross)
 * @returns {{ varRate: number, fixedNut: number, basis: 'all-in'|'running' }}
 */
function splitCosts(commercial, category, weeklyNut, baseVarRate, theaterPct) {
  const varRate = baseVarRate + (EXTRA_VARIABLE[category] ?? EXTRA_VARIABLE.musical);
  const basis = costBasis(commercial);
  // All-in at a gross equal to the figure: the gross-linked part at that gross comes off.
  const fixedNut = basis === 'all-in' ? weeklyNut * (1 - varRate - theaterPct) : weeklyNut;
  return { varRate, fixedNut, basis };
}

// Shadow cost basis (BRO-5093, opts.costBasis). weeklyRunningCost holds three
// kinds of figure, tagged by weeklyRunningCostBasis from the cited quote:
//
//   running     fixed weekly expenses, royalties and percentage rent extra
//               (Hamilton, Matilda). The model's own reading; unchanged.
//   breakeven   the gross the show needs to break even (Six, Gutenberg).
//               The fixed nut is B / breakEvenRatio (the model's own
//               zero-profit week, BRO-6217).
//   all-in      an average weekly operating expense, royalties and
//               percentage rent included (Outsiders, AG statements). The
//               gross-linked part at the period's average gross comes off;
//               the period is read from the quote ("52 week period ending
//               March 15, 2026"), else the figure is taken at a gross equal
//               to itself (a show near breakeven).
//
// Only the explicit field counts: text cues misfired (cost-split above).
const BASES = ['running', 'breakeven', 'all-in'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PERIOD = /\b(\d{1,3})[- ]week period ending\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i;

/** Average weekly gross over the period a quote names, or null. */
function periodGross(source, weekly) {
  const m = PERIOD.exec(String(source || ''));
  if (!m || !weekly) return null;
  const end = Date.UTC(Number(m[4]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[3]));
  const start = end - Number(m[1]) * 7 * 86400000;
  const grosses = Object.entries(weekly)
    .filter(([d]) => Date.parse(d) > start && Date.parse(d) <= end + 6 * 86400000)
    .map(([, w]) => (w && typeof w === 'object' ? w.gross : w))
    .filter((g) => g > 0);
  return grosses.length >= Math.min(8, Number(m[1])) ? grosses.reduce((a, b) => a + b, 0) / grosses.length : null;
}

/**
 * Break-even gross as a multiple of the fixed nut: the zero of the model's
 * steady-state week, G - varRate x G - max(0, pct x G - rent share x nut) - nut
 * (BRO-6217 M04). Below the theater breakpoint the rent is already in the nut,
 * so G = nut / (1 - varRate); only above it does the percentage branch apply.
 * The old closed form always took the percentage branch: a $500K nut at 11%
 * read $536,585, where the model's own week breaks even at $561,798.
 * @param {number} varRate
 * @param {{ pctOfGross: number, rentPctOfNut: number }} theater - THEATER_DEAL
 */
function breakEvenRatio(varRate, theater) {
  const belowBreakpoint = 1 / (1 - varRate);
  if (theater.pctOfGross * belowBreakpoint <= theater.rentPctOfNut) return belowBreakpoint;
  return (1 - theater.rentPctOfNut) / (1 - varRate - theater.pctOfGross);
}

/**
 * The fixed weekly nut behind a tagged cost figure.
 * @param {object} commercial
 * @param {number} weeklyNut - the figure the model would use
 * @param {number} varRate - live gross-linked rate (author royalty, fees)
 * @param {{ pctOfGross: number, rentPctOfNut: number }} theater - THEATER_DEAL
 * @param {object} [weekly] - weekly grosses, uncut, for an all-in period
 * @returns {{ nut: number, basis: string, gross?: number, fromPeriod?: boolean, rejected?: string }}
 */
function fixedNutFromBasis(commercial, weeklyNut, varRate, theater, weekly) {
  const basis = commercial && commercial.weeklyRunningCost && BASES.includes(commercial.weeklyRunningCostBasis) ? commercial.weeklyRunningCostBasis : 'running';
  const keep = 1 - theater.rentPctOfNut;
  if (basis === 'breakeven') return { nut: weeklyNut / breakEvenRatio(varRate, theater), basis };
  if (basis !== 'all-in') return { nut: weeklyNut, basis };
  const period = periodGross(commercial.weeklyRunningCostSource, weekly);
  const gross = period || weeklyNut;
  // E = nut + varRate x G + max(0, pct x G - rent share x nut)
  let nut = (weeklyNut - (varRate + theater.pctOfGross) * gross) / keep;
  if (theater.pctOfGross * gross <= theater.rentPctOfNut * nut) nut = weeklyNut - varRate * gross;
  return nut > 0 ? { nut, basis, gross, fromPeriod: !!period } : { nut: weeklyNut, basis: 'running', rejected: 'all-in' };
}

module.exports = { splitCosts, costBasis, fixedNutFromBasis, breakEvenRatio, periodGross, EXTRA_VARIABLE, COST_BASES: BASES, BASIS_CUE_TEXT };
