/**
 * Pre-opening critic score forecast (BRO-7314). Pure functions, no I/O.
 *
 * Inputs are ONLY facts known before a show's opening date: category/type,
 * revival flag, the same production's earlier-run score, and the track record
 * (earlier critic scores) of the director, writer and top-billed cast.
 * Every "history" lookup is filtered to shows that opened strictly before the
 * target show, so a backtest over time never leaks the future.
 *
 * Model: cohort mean + shrunken average residual of the people attached.
 *   pred = cohortMean + W * mean_over_people( n/(n+K) * personResidualMean )
 * clamped 30..98. Prior-run: when the same production has an earlier-run
 * score, blend it with the cohort-based prediction.
 */
const { foldDiacritics } = require('./title-match');
const PEOPLE_ROLES = /director|playwright|book|writer|composer|lyricist|music|choreograph/i;

function cohortKey(s) {
  return `${s.category || 'broadway'}:${s.type || 'play'}:${s.isRevival ? 'rev' : 'new'}`;
}
function coarseKey(s) { return `${s.category || 'broadway'}:${s.type || 'play'}`; }

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function normTitle(n) { return foldDiacritics(String(n || '')).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }
function norm(n) { return foldDiacritics(String(n || '')).toLowerCase().replace(/[^a-z ]/g, '').trim(); }

/** People attached to a show, split into creative and star cast (top 3 billed). */
function peopleOf(s, castTop = 3) {
  const creative = [];
  for (const c of s.creativeTeam || []) {
    if (c && c.name && PEOPLE_ROLES.test(c.role || '')) creative.push(norm(c.name));
  }
  const cast = (s.cast || []).slice(0, castTop).map((c) => norm(c.name)).filter(Boolean);
  return { creative: [...new Set(creative)], cast: [...new Set(cast)] };
}

/**
 * history: array of {id, openingDate, score, category, type, isRevival, people, originalProductionId, title}
 * target: same shape minus score. Only history rows with openingDate < target.openingDate are used.
 */
function forecast(target, history, opts = {}) {
  const K = opts.K ?? 3;
  const W = opts.W ?? 0.6;
  const priorW = opts.priorW ?? 0.5;
  const minCohort = opts.minCohort ?? 8;
  const past = history.filter((h) => h.openingDate < target.openingDate && h.score != null && h.id !== target.id);

  const fine = past.filter((h) => cohortKey(h) === cohortKey(target));
  const coarse = past.filter((h) => coarseKey(h) === coarseKey(target));
  const market = past.filter((h) => h.category === target.category);
  let base, basis;
  if (fine.length >= minCohort) { base = mean(fine.map((h) => h.score)); basis = 'cohort'; }
  else if (coarse.length >= minCohort) { base = mean(coarse.map((h) => h.score)); basis = 'type'; }
  else if (market.length >= minCohort) { base = mean(market.map((h) => h.score)); basis = 'market'; }
  else if (past.length >= minCohort) { base = mean(past.map((h) => h.score)); basis = 'all'; }
  else return null;

  // residual of each past show vs its own coarse cohort mean (prior to it is overkill; use the pool mean)
  const poolMean = {};
  for (const h of past) (poolMean[coarseKey(h)] ||= []).push(h.score);
  for (const k of Object.keys(poolMean)) poolMean[k] = mean(poolMean[k]);

  const byPerson = new Map();
  for (const h of past) {
    const r = h.score - poolMean[coarseKey(h)];
    for (const p of new Set([...(h.people?.creative || []), ...(h.people?.cast || [])])) {
      if (!byPerson.has(p)) byPerson.set(p, []);
      byPerson.get(p).push(r);
    }
  }
  const effects = [];
  for (const p of new Set([...(target.people?.creative || []), ...(target.people?.cast || [])])) {
    const rs = byPerson.get(p);
    if (rs && rs.length) effects.push((rs.length / (rs.length + K)) * mean(rs));
  }
  let pred = base + (effects.length ? W * mean(effects) : 0);

  let priorScore = null;
  if (target.originalProductionId || target.title) {
    const sib = past.filter((h) => (target.originalProductionId && h.originalProductionId === target.originalProductionId) ||
      (!(target.originalProductionId && h.originalProductionId) && h.title && target.title && h.category === target.category && h.type === target.type && normTitle(h.title) === normTitle(target.title)));
    if (sib.length) priorScore = sib.sort((a, b) => b.openingDate.localeCompare(a.openingDate))[0].score;
  }
  if (priorScore != null) pred = priorW * priorScore + (1 - priorW) * pred;
  pred = Math.max(30, Math.min(98, pred));
  return { pred, basis, baseline: base, nEffects: effects.length, priorScore, cohortN: fine.length };
}

function band(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  return 'Negative';
}

module.exports = { forecast, peopleOf, band, cohortKey, coarseKey, mean };
