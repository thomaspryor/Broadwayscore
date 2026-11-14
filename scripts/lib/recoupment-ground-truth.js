'use strict';

// Ground truth for the recoupment model (BRO-5002, BRO-4989). Every model
// change is scored against what was reported independently of the model:
//
//   reported-pct  estimatedRecoupmentPct [lo, hi] whose source is a report
//                 (trade press, filings, deep research, a grosses post), not
//                 our own inference ("Inferred:", "Estimated:")
//   recouped      recouped === true with a recoupedSource: truth is >= 100
//   failed        closed, recouped === false, any loss label (Fizzle, Flop,
//                 Did Not Recoup): truth is < 100 (the Fizzle/Flop split is
//                 not used; it can lean on older model output)
//
// A model central inside the truth range scores 0; outside, the distance to
// the nearest edge in points. Pure functions; the CLI is
// scripts/backtest-recoupment-ground-truth.js.
//
// Every row also carries truthClass (checker, 2026-10-10): 'reported' only
// when a trade outlet, the producers, an SEC filing, or the NYT / Deadline /
// Variety / Broadway Journal stated it; Reddit, deep-research summaries and
// our own synthesis are 'inference'. An explicit field on the record wins
// (TRUTH_CLASS_FIELD); without one the source text is classified, defaulting
// to 'inference'. A failed row is 'reported' only when a hard source states the
// outcome (did not recoup, closed at a loss): a cited capitalization or budget
// alone is inference about the outcome (checker, 2026-10-10). A reported-pct
// row is 'reported' only when its source also states a figure (BRO-5073).

const { isUnrecoupedDesignation } = require('./commercial-designations');

const OWN_INFERENCE = /^\s*(inferred|estimated)\b/i;
// A stated figure for the money returned or lost: a percentage beside
// recoup/returned/loss, a percentage of the capitalization, or a dollar loss
// ("$6M loss (~40% of cap)"). Shared with model-display-guard.js.
const STATED_PCT = /\b(recoup\w*|returned|paid back|earned back|loss|lost)\b[^.;]{0,60}?\d+(?:\.\d+)?\s*(?:%|percent)|\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of|on)\s*(?:its |the )?(?:cap|capitali[sz]ation|investment)\b/i;
const STATED_LOSS = /\b(loss|lost)\b[^.;]{0,30}?\$\s?\d|\$\s?\d+(?:\.\d+)?\s*(?:m|million)\b[^.;]{0,15}?\bloss/i;
/** Does the text state a figure for the money returned or lost? */
const statesFigure = (text) => STATED_PCT.test(String(text || '')) || STATED_LOSS.test(String(text || ''));

const TRUTH_CLASS_FIELD = {
  'reported-pct': 'estimatedRecoupmentTruthClass',
  recouped: 'recoupedTruthClass',
  failed: 'designationTruthClass',
};
// Anywhere in the text: an admission that nobody stated it.
const NO_STATEMENT = /\b(does not announce|no public announcement|no producer announcement|no recoupment was announced|no trade report|editorial judg)/i;
// Per sentence: a hard source, unless the same sentence leans on inference.
const HARD_SOURCE = /\b(deadline|variety|new york times|nyt|broadway journal|broadway news|playbill|broadwayworld|theatermania|hollywood reporter|forbes|wall street journal|wsj|new york theatre guide|trade publications|spokesperson|sec filing|edgar)\b|\bproducers?\b.{0,40}?\b(announced|announcement|confirmed|said|told|reported)\b/i;
const INFERENCE_SOURCE = /\b(reddit|deep research|gpt|dr|grosses analysis|post-mortem|inferred|estimated?|projected|likely)\b/i;
// Split on sentence ends (a closing quote may follow), but not after
// initials ("J.J. Powell"): the character before the stop is lower case.
const sentences = (text) => String(text).split(/(?<=[a-z0-9)%][.!?]["']?)\s+(?=[A-Z"'])/);

/** 'reported' | 'inference' for a source text. */
function classifySourceText(text) {
  if (!text || NO_STATEMENT.test(text)) return 'inference';
  return sentences(text).some((s) => HARD_SOURCE.test(s) && !INFERENCE_SOURCE.test(s)) ? 'reported' : 'inference';
}

// A sentence that states the loss itself, not just the cost.
const LOSS_OUTCOME = /\b(did not recoup|didn't recoup|never recoup|not recoup|failed to recoup|without recouping|unrecouped|lost (?:its|the|most|all|nearly|about|an estimated|\$)|loss(?:es)? (?:to|of|for)|at a loss|major losses|wiped out|investors (?:lost|got back))/i;

/** 'reported' when one sentence names a hard source and states the loss. */
function classifyFailedText(text) {
  if (!text || NO_STATEMENT.test(text)) return 'inference';
  return sentences(text).some((s) => LOSS_OUTCOME.test(s) && HARD_SOURCE.test(s) && !INFERENCE_SOURCE.test(s)) ? 'reported' : 'inference';
}

/** @returns {{ truthClass: 'reported'|'inference', truthClassFrom: 'field'|'source-text' }} */
function truthClassOf(comm, kind, sourceText) {
  const explicit = comm && comm[TRUTH_CLASS_FIELD[kind]];
  if (explicit === 'reported' || explicit === 'inference') return { truthClass: explicit, truthClassFrom: 'field' };
  // A range is a point estimate only when the source states a figure; a
  // quote like "among the season's largest losses" turned into 0..10 by us is
  // our inference, whoever said the words (BRO-5073: Queen of Versailles,
  // Little Bear Ridge Road).
  if (kind === 'reported-pct' && !statesFigure(sourceText)) return { truthClass: 'inference', truthClassFrom: 'no-stated-figure' };
  if (kind === 'failed') {
    const text = [comm.notes, comm.recoupedSource, comm.classifiedReason].filter((v) => typeof v === 'string').join(' ');
    return { truthClass: classifyFailedText(text), truthClassFrom: 'source-text' };
  }
  return { truthClass: classifySourceText(sourceText), truthClassFrom: 'source-text' };
}

/**
 * @returns {null | { kind: 'reported-pct'|'recouped'|'failed', lo: number, hi: number, source: string, asOf?: string,
 *   truthClass: 'reported'|'inference', truthClassFrom: string }}
 */
// A record can hold more than one outcome claim (a Reddit % returned and a
// trade-announced recoupment, Just in Time). The first reported claim wins;
// with none, the first claim stands, as before (BRO-5264).
function groundTruth(comm, show, now = new Date()) {
  const all = classifiedCandidates(comm, show, now);
  return all.find((t) => t.truthClass === 'reported') || all[0] || null;
}

function classifiedCandidates(comm, show, now) {
  return truthCandidates(comm, show, now)
    .map((t) => ({ ...t, ...truthClassOf(comm, t.kind, t.source), creditBasis: creditBasis(comm, t.source, t.kind) }));
}

/**
 * The rows a record is scored on: its groundTruth() claim in its tier and,
 * an inference % the reported claim displaced, as an advisory row (ship-check
 * BRO-5311: Chess's Reddit 10-20% lost to a designation-wide failed row and
 * was scored nowhere). Under --truth=all too: the reported claim now outranks
 * it there as well (BRO-5264 retro-review, BRO-5261).
 * @returns {Array<{ truth: object, tier: 'gate'|'advisory', superseded?: true }>}
 */
function truthRows(comm, show, mode, now = new Date()) {
  const truth = groundTruth(comm, show, now);
  const tier = truthTier(truth, mode);
  if (!tier) return [];
  const out = [{ truth, tier }];
  if (tier === 'gate' && truth.kind !== 'reported-pct') {
    const pct = classifiedCandidates(comm, show, now).find((t) => t.kind === 'reported-pct' && t.truthClass !== 'reported');
    if (pct) out.push({ truth: pct, tier: 'advisory', superseded: true });
  }
  return out;
}

// Pre- or post-NY-tax-credit basis of a truth figure (BRO-5073). Post only
// when the source counts a credit already in hand ("operating profit plus the
// NY State tax credit"); "eligible for", "would", "if received" and "will"
// are a credit not yet in the figure, as are "not including", "to follow" and
// "once received". An explicit taxCreditBasis field wins. A recoupment that
// does not say is 'unstated': short runs often declare recoupment counting the
// credit, and announcements rarely say which, so such a row is scored on
// whichever basis fits (eitherBasis). An amount returned or lost with no
// credit in it stays pre-credit.
// W: up to 40 characters inside one clause; a decimal point ($2.5M) is not a clause end.
const W = '(?:[^.;|]|\\.(?=\\d)){0,40}';
const CREDIT_IN = new RegExp(`\\b(plus|including|includes|after)\\b${W}\\btax credits?\\b`, 'i');
const CREDIT_HEDGE = new RegExp(`\\b(eligible|would|if|will|expected|pending|not|excluding|before|may|could|once|when)\\b${W}\\btax credits?\\b|\\btax credits?\\b${W}\\b(would|if|will|to follow|may|could|once|when)\\b`, 'i');
/** @returns {'pre-credit'|'post-credit'|'unstated'} */
function creditBasis(comm, sourceText, kind) {
  const explicit = comm && comm.taxCreditBasis;
  if (explicit === 'pre-credit' || explicit === 'post-credit') return explicit;
  const text = String(sourceText || '');
  if (CREDIT_IN.test(text) && !CREDIT_HEDGE.test(text)) return 'post-credit';
  return kind === 'recouped' ? 'unstated' : 'pre-credit';
}

/**
 * An 'unstated' row is inside when either the pre- or the post-credit model
 * fits: the side with the smaller error is the one scored (pre on a tie).
 * @param {{ err: number }} pre @param {{ err: number }} post
 */
function eitherBasis(pre, post) {
  return post.err < pre.err ? { ...post, usedPost: true } : { ...pre, usedPost: false };
}

/** One line: rows per credit basis, and how many unstated rows the post-credit side carried. */
function basisLine(rows) {
  const n = (f) => rows.filter(f).length;
  return `Credit basis: ${n((r) => r.creditBasis === 'pre-credit')} pre-credit, ${n((r) => r.creditBasis === 'post-credit')} post-credit, ${n((r) => r.creditBasis === 'unstated')} unstated (${n((r) => r.usedPost === true)} scored on the post-credit side)`;
}

// Recouped after the Broadway run closed, with the source crediting a tour
// (Kimberly Akimbo, Playbill Apr 23, 2026): the Broadway-only model cannot
// see tour profits, so this is not a test of it (BRO-5073).
const TOUR_CREDIT = /\btour\b/i;
function recoupedFromTour(comm, show) {
  const close = show && show.closingDate;
  return !!close && typeof comm.recoupedDate === 'string' && comm.recoupedDate.slice(0, 7) > close.slice(0, 7)
    && TOUR_CREDIT.test(String(comm.recoupedSource) + ' ' + String(comm.notes || ''));
}

/** Outcome claims in priority order: a % returned, then recouped, then failed. */
function truthCandidates(comm, show, now) {
  if (!comm) return [];
  const out = [];
  const est = comm.estimatedRecoupmentPct;
  // Older records keep the range's basis in notes, not estimatedRecoupmentSource.
  const basis = comm.estimatedRecoupmentSource || comm.notes;
  if (Array.isArray(est) && est.length === 2 && est.every((v) => typeof v === 'number')
    && basis && !OWN_INFERENCE.test(basis)) {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(comm.estimatedRecoupmentDate || '') ? comm.estimatedRecoupmentDate : null;
    out.push({ kind: 'reported-pct', lo: Math.min(...est), hi: Math.max(...est), source: String(basis), ...(asOf ? { asOf } : {}) });
  }
  // A recoupment the source credits to a tour is no test of the Broadway model.
  if (comm.recouped === true && comm.recoupedSource && !recoupedFromTour(comm, show)) {
    out.push({ kind: 'recouped', lo: 100, hi: Infinity, source: String(comm.recoupedSource) });
  }
  const closed = show && show.closingDate && new Date(show.closingDate) <= now;
  if (closed && comm.recouped === false && isUnrecoupedDesignation(comm.designation)) {
    out.push({ kind: 'failed', lo: -Infinity, hi: 99.99, source: `designation ${comm.designation}` });
  }
  return out;
}

/** Points outside the truth range; 0 when inside. */
function rangeError(pct, truth) {
  if (typeof pct !== 'number' || !truth) return null;
  if (pct < truth.lo) return truth.lo - pct;
  if (pct > truth.hi) return pct - truth.hi;
  return 0;
}

function category(show) {
  const type = show && show.type === 'play' ? 'play' : 'musical';
  const year = show && show.openingDate ? Number(String(show.openingDate).slice(0, 4)) : null;
  return { type, era: year != null && year < 2020 ? 'pre-2020' : '2020+' };
}

/**
 * @param {Array<{ kind: string, type: string, era: string, oldErr: number, newErr: number }>} rows
 * @returns per-group { n, oldMae, newMae, oldInside, newInside } for all, each kind, type and era
 */
function summarize(rows) {
  const groups = { all: rows };
  for (const r of rows) {
    for (const g of [`kind:${r.kind}`, `type:${r.type}`, `era:${r.era}`]) (groups[g] = groups[g] || []).push(r);
  }
  const round = (v) => Math.round(v * 10) / 10;
  const out = {};
  for (const [name, rs] of Object.entries(groups)) {
    const mae = (k) => (rs.length ? round(rs.reduce((a, r) => a + r[k], 0) / rs.length) : null);
    const median = (k) => {
      const v = rs.map((r) => r[k]).sort((a, b) => a - b);
      return v.length ? round(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
    };
    out[name] = {
      n: rs.length,
      oldMae: mae('oldErr'), newMae: mae('newErr'),
      oldMedian: median('oldErr'), newMedian: median('newErr'),
      oldInside: rs.filter((r) => r.oldErr === 0).length,
      newInside: rs.filter((r) => r.newErr === 0).length,
    };
  }
  return out;
}

/** Groups with at least minN rows whose mean error rose or in-range count fell. */
function worseGroups(summary, { minN = 1 } = {}) {
  return Object.entries(summary)
    .filter(([, s]) => s.n >= Math.max(1, minN) && (s.newMae > s.oldMae || s.newInside < s.oldInside))
    .map(([name]) => name);
}

/**
 * Which tier a truth row is scored in: 'gate' rows decide --strict and the CI
 * annotations; 'advisory' rows (inference truth under --truth=reported) are
 * scored on their own line and never gate (checker 2026-10-10).
 * @param {{ truthClass: string } | null} truth
 * @param {'reported'|'all'} mode
 * @returns {'gate'|'advisory'|null} null when there is no truth to score
 */
function truthTier(truth, mode) {
  if (!truth) return null;
  return truth.truthClass !== 'reported' && mode === 'reported' ? 'advisory' : 'gate';
}

/** Rows the truth says never recouped (top of range under 100) that only the new side puts at 100%+. */
const newFalseRecouped = (rows) => rows.filter((r) => r.truth[1] < 100 && r.newPct >= 100 && !(r.oldPct >= 100));

/**
 * One line for the inference tier (Reddit, deep research, our own synthesis).
 * Owner 2026-10-13: show how a change does against these rows too, but they
 * never gate a switch (checker 2026-10-10): many share the model's method, so
 * agreement with them is weak evidence. The caller keeps them out of --strict.
 * @param {object[]} rows scored rows, same shape as the reported rows
 * @param {{ minN?: number }} [o]
 * @returns {string}
 */
function advisoryLine(rows, { minN = 1 } = {}) {
  const label = 'Advisory, inference truth rows: Reddit, AI research, our estimates, unsourced loss labels (not counted toward pass or fail)';
  if (!rows.length) return `${label}: none scored`;
  const s = summarize(rows);
  const worse = worseGroups(s, { minN });
  const falseRec = newFalseRecouped(rows).length;
  const a = s.all;
  return `${label}: ${a.n} rows, mean error ${a.oldMae} -> ${a.newMae}, inside ${a.oldInside} -> ${a.newInside}, `
    + `${worse.length ? `worse in ${worse.join(', ')}` : 'no group worse'}, new false recouped ${falseRec}`;
}

const fmtTruth = (truth) => truth.map((v) => (Number.isFinite(v) ? v : (v > 0 ? '+inf' : '-inf'))).join('..');
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * GitHub-markdown before/after report (CI step summary).
 * @param {{ title: string, summary: object, rows: object[], worse: string[], limit?: number }} r
 * @returns {string}
 */
// aggregateOnly: counts and group stats, no show names or per-show numbers (public CI logs).
function formatMarkdown({ title, summary, rows, worse, limit = 15, aggregateOnly = false }) {
  const out = [`### ${title}`, '', '| group | n | old MAE | new MAE | old median | new median | old inside | new inside |', '|---|--:|--:|--:|--:|--:|--:|--:|'];
  for (const [g, s] of Object.entries(summary)) out.push(`| ${g} | ${s.n} | ${s.oldMae} | ${s.newMae} | ${s.oldMedian} | ${s.newMedian} | ${s.oldInside} | ${s.newInside} |`);
  const moved = rows.filter((r) => r.oldErr !== r.newErr).sort((a, b) => Math.abs(b.newErr - b.oldErr) - Math.abs(a.newErr - a.oldErr));
  out.push('');
  if (!moved.length) out.push('No row moved.');
  else if (aggregateOnly) out.push(`Error changed on ${moved.length} rows (per-show detail is printed only outside CI).`);
  else {
    out.push(`Error changed on ${moved.length}${moved.length > limit ? ` (top ${limit})` : ''}:`, '', '| show | kind | truth | old % | new % | old error | new error |', '|---|---|---|--:|--:|--:|--:|');
    for (const r of moved.slice(0, limit)) out.push(`| ${r.slug} | ${r.kind} | ${fmtTruth(r.truth)} | ${r.oldPct} | ${r.newPct} | ${r1(r.oldErr)} | ${r1(r.newErr)} |`);
  }
  out.push('', worse.length ? `**Worse in:** ${worse.join(', ')}` : 'No group got worse.', '');
  return out.join('\n');
}

module.exports = {
  creditBasis, eitherBasis, basisLine,
  recoupedFromTour, STATED_PCT, statesFigure, groundTruth, truthClassOf, classifySourceText, classifyFailedText, TRUTH_CLASS_FIELD, rangeError, category, summarize, worseGroups, truthTier, truthRows, newFalseRecouped, advisoryLine, formatMarkdown, fmtTruth, OWN_INFERENCE };
