#!/usr/bin/env node
/**
 * Which shows change score visibility because of the standing score-gate rule (BRO-8163)?
 * scoring-delta.js covers inclusion and score values, not the display gate.
 * Compares scoreGateArg(showId) (explicit overrides only) with scoreGateArg(show) (full rule).
 * Usage: node scripts/score-gate-delta.js [--json]
 */
const fs = require('fs');
const path = require('path');
const { computeCriticScore } = require('./lib/compute-critic-score');
const { hasEnoughReviews } = require('./lib/min-reviews');
const { scoreGateArg } = require('./lib/should-hide-reviews');
const { scoreGateReason } = require('./lib/score-gate-rule');

const D = path.join(__dirname, '..', 'data');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const sj = rd('shows.json');
const shows = Array.isArray(sj) ? sj : sj.shows;
const rj = rd('reviews.json');
const reg = rd('outlet-registry.json').outlets;
const byShow = {};
for (const r of Array.isArray(rj) ? rj : Object.values(rj.reviews || rj)) (byShow[r.showId] = byShow[r.showId] || []).push(r);

const changed = [];
for (const s of shows) {
  const why = scoreGateReason(s);
  if (!why) continue;
  const res = computeCriticScore(byShow[s.id] || [], reg, s.category, s.type);
  if (!res) continue;
  const before = hasEnoughReviews(res.rc, s.category, res.t1 + res.t2, scoreGateArg(s.id));
  const after = hasEnoughReviews(res.rc, s.category, res.t1 + res.t2, scoreGateArg(s));
  if (before !== after) changed.push({ id: s.id, status: s.status, category: s.category, why, reviews: res.rc, before, after });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(changed, null, 2));
else {
  console.log(`${changed.length} show(s) change score visibility`);
  for (const c of changed) console.log(`${c.id}\t${c.status}\t${c.category}\t${c.why}\trc=${c.reviews}\t${c.before}->${c.after}`);
}
