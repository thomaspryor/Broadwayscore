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
const RUNNING_TEXT = /\bexcl\w*\s+royalt|\bbefore royalt|\bpure operating\b/i;

/** 'all-in' | 'running' for the record's weekly cost figure. */
function costBasis(commercial) {
  const explicit = commercial && commercial.weeklyRunningCostBasis;
  if (explicit === 'all-in' || explicit === 'running') return explicit;
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

module.exports = { splitCosts, costBasis, EXTRA_VARIABLE };
