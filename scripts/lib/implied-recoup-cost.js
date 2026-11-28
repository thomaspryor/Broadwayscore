'use strict';

// Weekly cost implied by a reported recoupment date (BRO-5607). A show that
// announced recoupment pins its cost: replay the model on the weeks played up
// to the announcement (pre-credit, no reserve) and find the fixed weekly nut
// at which cumulative operating profit reaches 100% of the capitalization on
// that date. Romeo + Juliet (2024) recouped in its final week on public
// grosses; its estimated $650K cost read 56% there.
//
// Only where the date says more than the cost does:
//   - a play (plays, star-driven or not: limited runs whose cost holds
//     through the run; a musical's later, weaker weeks read as losses at a
//     nut set by its peak, Mean Girls and Just in Time in the backtest);
//   - a reported recoupment (not our inference), not counted with the tax
//     credit (a post-credit recoupment needs less operating profit), and not
//     straddling the 2020-21 shutdown (grants and dark weeks), and announced
//     during the run or just after it (later, it came from the credit or
//     the tour: The Piano Lesson);
//   - the run after recoupment is at most POST_RECOUP_MAX_WEEKS, so the nut
//     describes the weeks the model goes on to project;
//   - the cost on the record is not a cited reported figure, unless the show
//     is a star-driven play, whose reported running cost leaves out the
//     star's gross participation (Good Night, and Good Luck).
// Pure: the caller passes the model run; this file reads no data.

const { announcementDate, hideRecoupment } = require('./recoupment-timing');
const { truthClassOf, creditBasis } = require('./recoupment-ground-truth');

const POST_RECOUP_MAX_WEEKS = 52;
const MIN_WEEKS_BEFORE = 4;
const AFTER_CLOSE_DAYS = 28;
const PLAY_CATEGORIES = ['play', 'playStar'];
const BAND = [0.4, 2.5]; // the implied nut must sit within this multiple of the current one
const SHUTDOWN_START = '2020-03-12';
const ITERATIONS = 30;
const WEEK_MS = 7 * 86400000;

/**
 * @param {object} show - shows.json record
 * @param {object} comm - commercial.json record
 * @param {{ currentNut: number, category: string, citedCost: boolean, weeklyDates: string[], today?: Date,
 *           pctAt: (nut: number, asOf: string) => (number|null) }} ctx
 *   pctAt runs the model on the record with its recoupment hidden, the given
 *   nut, as of the date, pre-credit with no reserve; it returns the central.
 * @returns {{ nut: number, date: string } | { skip: string }}
 */
function impliedRecoupNut(show, comm, ctx) {
  if (!comm || comm.recouped !== true || !comm.recoupedSource) return { skip: 'not a reported recoupment' };
  if (truthClassOf(comm, 'recouped', comm.recoupedSource).truthClass !== 'reported') return { skip: 'recoupment is an inference' };
  if (creditBasis(comm, comm.recoupedSource, 'recouped') === 'post-credit') return { skip: 'recouped with the tax credit' };
  if (!PLAY_CATEGORIES.includes(ctx.category)) return { skip: 'not a play' };
  const ann = announcementDate(comm);
  if (!ann) return { skip: 'no dated recoupment' };
  let date = ann.precision === 'day' ? ann.date : `${ann.date.slice(0, 7)}-15`;
  if (show.closingDate && Date.parse(date) > Date.parse(show.closingDate) + AFTER_CLOSE_DAYS * 86400000) return { skip: 'recoupment announced well after closing' };
  if (show.closingDate && show.closingDate < date) date = show.closingDate;
  const start = show.previewsStartDate || show.openingDate;
  if (!start) return { skip: 'no start date' };
  if (start < SHUTDOWN_START && date >= SHUTDOWN_START) return { skip: 'run straddles the 2020-21 shutdown' };
  const end = show.closingDate ? Date.parse(show.closingDate) : (ctx.today || new Date()).getTime();
  if ((end - Date.parse(date)) / WEEK_MS > POST_RECOUP_MAX_WEEKS) return { skip: `more than ${POST_RECOUP_MAX_WEEKS} weeks after recoupment` };
  if (ctx.citedCost && ctx.category !== 'playStar') return { skip: 'cited reported cost' };
  const before = ctx.weeklyDates.filter((d) => d <= date && d >= start).length;
  if (before < MIN_WEEKS_BEFORE) return { skip: 'too few weeks of grosses before recoupment' };

  let lo = ctx.currentNut * BAND[0];
  let hi = ctx.currentNut * BAND[1];
  const atLo = ctx.pctAt(lo, date);
  const atHi = ctx.pctAt(hi, date);
  if (atLo == null || atHi == null) return { skip: 'model did not run at the recoupment date' };
  if (atLo < 100 || atHi > 100) return { skip: 'no nut in the band reaches 100% on the date' };
  for (let i = 0; i < ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (ctx.pctAt(mid, date) >= 100) lo = mid;
    else hi = mid;
  }
  return { nut: Math.round(lo), date };
}

module.exports = { impliedRecoupNut, hideRecoupment, POST_RECOUP_MAX_WEEKS };
