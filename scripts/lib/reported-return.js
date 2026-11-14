'use strict';
// BRO-5313: the "% returned to investors" a closed show may print. Only a figure a
// named trade outlet states in the source text (recoupment-ground-truth's 'reported'
// class for the reported-pct claim, which also requires a stated figure). Reddit,
// deep-research and our own inference never pass. Never infers a number.

const { groundTruth, statesFigure } = require('./recoupment-ground-truth');
const { hasNoInvestorsToRepay } = require('./commercial-designations');

// Outlets a reader recognises; matched in the source text, label is what prints.
const OUTLETS = [
  [/\bbroadway journal\b/i, 'Broadway Journal'],
  [/\bbroadway news\b/i, 'Broadway News'],
  [/\bnew york times\b|\bnyt\b/i, 'The New York Times'],
  [/\bwall street journal\b|\bwsj\b/i, 'The Wall Street Journal'],
  [/\bdeadline\b/i, 'Deadline'],
  [/\bvariety\b/i, 'Variety'],
  [/\bplaybill\b/i, 'Playbill'],
  [/\bbroadwayworld\b/i, 'BroadwayWorld'],
  [/\btheatermania\b/i, 'TheaterMania'],
  [/\bhollywood reporter\b/i, 'The Hollywood Reporter'],
  [/\bforbes\b/i, 'Forbes'],
  [/\bnew york theatre guide\b/i, 'New York Theatre Guide'],
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A sentence leaning on these is not a trade outlet's statement.
const NOT_TRADE = /\b(reddit|deep research|gpt|grosses analysis|inferred|estimated?|projected|likely|users?|commenters?|fans?|rumou?rs?)\b/i;
// "returned 55-60%", "recouped about 60%", "got back 5% and 10%": a RETURN figure. A loss
// percentage is never converted into one.
const RETURN_VERB = /\b(?:return(?:ed|ing)?|recoup(?:ed|ing)?|paid back|earned back|got back|get back)\b/i;
const PCT = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(?:%|percent)/gi;
// Plain-words equivalents of "0% returned": the outlet says nothing came back.
const NOTHING_RETURNED = /\b(?:lost (?:their|its|the) entire investments?|total loss to (?:its )?investors|(?:has|had|have)(?:n't| not) returned any money|no money (?:was |has been )?returned)\b/i;
const sentencesOf = (text) => String(text).split(/(?<=[a-z0-9)%][.!?]["']?)\s+(?=[A-Z"'])/);

// Every outlet named in the text, with where it first appears.
function outletsIn(text) {
  const out = [];
  for (const [re, label] of OUTLETS) {
    const m = re.exec(text);
    if (m) out.push({ label, index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

// A source that opens "Outlet (Mon DD, YYYY): ..." names its publisher up front.
function leadingPublisher(text) {
  const lead = /^\s*([^(:]{2,40}?)\s*\(\s*([A-Z][a-z]{2})[a-z]*\.? \d{1,2},? (\d{4})/.exec(text);
  const hit = lead && outletsIn(lead[1])[0];
  return hit ? { label: hit.label, asOf: `${lead[2]} ${lead[3]}` } : null;
}

// The figure of one sentence: a returned-% range, or 0 when it says nothing came back.
function figureOf(sentence) {
  if (NOTHING_RETURNED.test(sentence)) return [0, 0];
  const v = RETURN_VERB.exec(sentence);
  if (!v) return null;
  const nums = [];
  for (const m of sentence.slice(v.index).matchAll(PCT)) {
    nums.push(Number(m[1]));
    if (m[2] != null) nums.push(Number(m[2]));
  }
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}

// Is N stated as "N%" / "N percent" in the text? (0 also when the outlet says nothing came back.)
const statesPct = (text, n) => (n === 0 && NOTHING_RETURNED.test(text)) || new RegExp(`(?<![\\d.])${n}(?:\\.0+)?\\s*(?:%|percent)`, 'i').test(text);

/**
 * The first sentence that states a returned %, with the outlet that states it. Null when
 * that sentence leans on Reddit/inference, or names two outlets with no publisher leading
 * the source (ambiguous who said it). Figures are never merged across sentences.
 */
function statedReturn(text) {
  const lead = leadingPublisher(text);
  for (const sentence of sentencesOf(text)) {
    const range = figureOf(sentence);
    if (!range) continue;
    if (NOT_TRADE.test(sentence)) return null;
    const here = outletsIn(sentence);
    let outlet = null;
    let asOf = null;
    if (lead) { outlet = lead.label; asOf = lead.asOf; }
    else if (here.length === 1) outlet = here[0].label;
    else if (here.length === 0) {
      const all = outletsIn(text);
      outlet = all.length === 1 ? all[0].label : null;
    }
    return outlet ? { range, outlet, asOf, sentence, led: !!lead } : null;
  }
  return null;
}

function monthYear(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso || '');
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/**
 * @returns {null | { lo: number, hi: number, outlet: string, asOf: string | null }}
 * Null unless the show is closed with a final designation, has investors to
 * repay (hasNoInvestorsToRepay: a nonprofit with enhancement money counts),
 * has not recouped, and a named trade outlet states the figure.
 */
function reportedReturn(comm, show) {
  if (!comm || !show || show.status !== 'closed') return null;
  if (comm.recouped === true || hasNoInvestorsToRepay(comm)) return null;
  if (!comm.designation || comm.designation === 'TBD') return null;
  const truth = groundTruth(comm, show);
  if (!truth || truth.kind !== 'reported-pct' || truth.truthClass !== 'reported') return null;
  if (!statesFigure(truth.source)) return null;
  const text = String(truth.source);
  const stated = statedReturn(text);
  if (!stated) return null;
  let [lo, hi] = stated.range.map((v) => Math.round(v));
  // Print the stored range only when each end is itself stated in the source
  // (Hell's Kitchen: 60% via the NYT, 55% from an investor); else the sentence's own figure.
  // Both ends must sit in the figure's own sentence, or the whole source is one publisher's.
  const scope = stated.led ? text : stated.sentence;
  if (statesPct(scope, Math.round(truth.lo)) && statesPct(scope, Math.round(truth.hi))) { lo = Math.round(truth.lo); hi = Math.round(truth.hi); }
  // A stated figure must sit inside the stored range, and 100%+ is a recoupment, not this.
  if (hi >= 100 || lo < truth.lo - 0.5 || hi > truth.hi + 0.5) return null;
  return { lo, hi, outlet: stated.outlet, asOf: stated.asOf || monthYear(truth.asOf) };
}

/** Reader wording: "Investors got back about 55-60% (Broadway Journal, Oct 2026)". */
function reportedReturnLabel(rr) {
  if (!rr) return null;
  const figure = rr.hi === 0 ? 'none of their money' : `about ${rr.lo === rr.hi ? rr.lo : `${rr.lo}-${rr.hi}`}%`;
  const cite = rr.asOf ? `${rr.outlet}, ${rr.asOf}` : rr.outlet;
  return `Investors got back ${figure} (${cite})`;
}

module.exports = { reportedReturn, reportedReturnLabel, statedReturn };
