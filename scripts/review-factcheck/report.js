#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 review fact-check, step 5: per-check error rates and show impact.
 * Final verdict per check = the adjudication (data/audit/review-factcheck/
 * adjudications.json) when one exists, else the agreed vote. Rates carry a
 * Wilson 95% interval, raw and re-weighted to each stratum's tier mix (the
 * sample over-draws T1/T2). Show impact uses computeCriticScore on the show's
 * reviews.json rows with the wrong items removed (a, b) or re-scored (f), and
 * is reported as a delta on getCriticScore's published value.
 *
 * Usage: node scripts/review-factcheck/report.js  -> data/audit/review-factcheck/report.{json,md}
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeCriticScore } = require('../lib/compute-critic-score');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const AUDIT = path.join(ROOT, 'data/audit/review-factcheck');
const CHECKS = { isReview: 'a. is a review', thisProduction: 'b. this production', outletMatches: 'c. outlet', criticMatches: 'd. critic byline', dateMatches: 'e. publish date', score: 'f. score' };

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96; const p = k / n;
  const den = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / den;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = x => (100 * x).toFixed(1) + '%';

function finalVerdict(vote, adj) {
  if (adj && adj.verdict) return adj.verdict; // ok | error | unverifiable
  if (!vote) return 'pending';
  if (vote.verdict === 'ok' || vote.verdict === 'unverifiable') return vote.verdict;
  return 'pending';
}

function showImpact(showId, changes, reviewsByShow, shows, registry) {
  const show = shows.get(showId) || {};
  const rows = (reviewsByShow.get(showId) || []).map(r => ({ ...r }));
  const before = computeCriticScore(rows, registry, show.category, show.type);
  let after = rows;
  for (const ch of changes) {
    const i = after.findIndex(r => (ch.url ? r.url === ch.url : (r.outlet === ch.outlet && r.criticName === ch.criticName)));
    if (i < 0) continue;
    if (ch.remove) after = after.filter((_, j) => j !== i);
    else if (typeof ch.newScore === 'number') after[i] = { ...after[i], assignedScore: ch.newScore };
  }
  const res = computeCriticScore(after, registry, show.category, show.type);
  const slimPath = path.join(ROOT, 'public/data/shows', showId + '.json');
  const published = fs.existsSync(slimPath) ? JSON.parse(fs.readFileSync(slimPath, 'utf8')).cs : null;
  const delta = before && res ? res.s - before.s : null;
  return { published: published == null ? null : Math.round(published), corrected: published == null || delta == null ? null : Math.round(published + delta), delta: delta == null ? null : Math.round(delta * 10) / 10 };
}

function main() {
  const sampleDoc = JSON.parse(fs.readFileSync(path.join(AUDIT, 'sample.json'), 'utf8'));
  const sample = new Map(sampleDoc.sample.map(s => [s.sampleId, s]));
  const votes = JSON.parse(fs.readFileSync(path.join(CACHE, 'votes.json'), 'utf8'));
  const adjPath = path.join(AUDIT, 'adjudications.json');
  const adj = fs.existsSync(adjPath) ? JSON.parse(fs.readFileSync(adjPath, 'utf8')) : {};
  const shows = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows.map(s => [s.id, s]));
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')).reviews;
  const reviewsByShow = new Map();
  for (const r of reviews) { if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []); reviewsByShow.get(r.showId).push(r); }
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/outlet-registry.json'), 'utf8')).outlets || {}; } catch { /* default tiers */ }

  const rows = votes.map(v => {
    const a = adj[v.sampleId] || {};
    const final = {};
    for (const c of Object.keys(CHECKS)) final[c] = finalVerdict(v.checks[c], a[c]);
    return { ...v, final, adj: a };
  });

  const table = {};
  for (const c of Object.keys(CHECKS)) {
    const t = { checked: 0, errors: 0, unverifiable: 0, pending: 0, byStratum: {} };
    for (const r of rows) {
      const f = r.final[c];
      const s = (t.byStratum[r.stratum] = t.byStratum[r.stratum] || { checked: 0, errors: 0, wErr: 0, wAll: 0 });
      if (f === 'unverifiable') { t.unverifiable++; continue; }
      if (f === 'pending') { t.pending++; continue; }
      t.checked++; s.checked++;
      // Re-weight to the stratum's tier mix: weight = population share / sample share of the row's tier.
      const pop = sampleDoc.population[r.stratum];
      const sampledInTier = rows.filter(x => x.stratum === r.stratum && x.tier === r.tier).length;
      const w = (pop.byTier[r.tier] / pop.total) / (sampledInTier / rows.filter(x => x.stratum === r.stratum).length);
      s.wAll += w;
      if (f === 'error') { t.errors++; s.errors++; s.wErr += w; }
    }
    t.rate = t.checked ? t.errors / t.checked : 0;
    t.ci = wilson(t.errors, t.checked);
    for (const s of Object.values(t.byStratum)) { s.rate = s.checked ? s.errors / s.checked : 0; s.ci = wilson(s.errors, s.checked); s.weightedRate = s.wAll ? s.wErr / s.wAll : 0; }
    table[c] = t;
  }

  // Wrong items + show impact.
  const wrong = [];
  const changesByShow = new Map();
  for (const r of rows) {
    const errs = Object.keys(CHECKS).filter(c => r.final[c] === 'error');
    if (!errs.length) continue;
    const it = sample.get(r.sampleId);
    const change = { url: it.url, outlet: it.outlet, criticName: it.criticName };
    if (errs.includes('isReview') || errs.includes('thisProduction')) change.remove = true;
    else if (errs.includes('score') && typeof (r.adj.score || {}).correctScore === 'number') change.newScore = r.adj.score.correctScore;
    if (change.remove || change.newScore != null) { if (!changesByShow.has(it.showId)) changesByShow.set(it.showId, []); changesByShow.get(it.showId).push(change); }
    wrong.push({ sampleId: r.sampleId, stratum: r.stratum, tier: r.tier, showId: it.showId, outlet: it.outlet, criticName: it.criticName, url: it.url, ourScore: it.score, errors: errs.map(c => ({ check: c, note: (r.adj[c] || {}).note || null, sourceUrl: (r.adj[c] || {}).url || it.url || null, correctScore: (r.adj[c] || {}).correctScore })) });
  }
  const impact = {};
  for (const [showId, changes] of changesByShow) impact[showId] = showImpact(showId, changes, reviewsByShow, shows, registry);

  // 'missing' = we show no critic but the page names one (not a wrong name).
  const missingCritic = rows.filter(r => r.final.criticMatches === 'missing').map(r => r.sampleId);
  const softScore = { bothModelsOtherBucket: rows.filter(r => r.checks.score && r.checks.score.bucketMismatch).length, n: rows.filter(r => r.checks.score && r.checks.score.models && r.checks.score.models.length === 2).length };
  const report = { generatedAt: new Date().toISOString(), missingCritic, sampleSize: rows.length, perStratum: sampleDoc.perStratum, population: sampleDoc.population, table, softScore, wrong, impact };
  fs.writeFileSync(path.join(AUDIT, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  const md = [];
  md.push('# BRO-5081 review fact-check', '', `Sample: ${rows.length} reviews that count on the live site (seed ${sampleDoc.seed}), ${sampleDoc.perStratum} per stratum, T1/T2 over-drawn 4:2:1. Rates: errors / reviews with a verdict, Wilson 95% interval; "weighted" re-weights to the stratum's real tier mix.`, '');
  md.push('| Check | Checked | Errors | Rate (95% CI) | WE hist (weighted) | BW hist (weighted) | Unverifiable | Pending |', '|---|---|---|---|---|---|---|---|');
  for (const [c, label] of Object.entries(CHECKS)) {
    const t = table[c]; const we = t.byStratum['we-historical'] || {}; const bw = t.byStratum['bw-historical'] || {};
    md.push(`| ${label} | ${t.checked} | ${t.errors} | ${pct(t.rate)} (${pct(t.ci[0])}-${pct(t.ci[1])}) | ${we.errors || 0}/${we.checked || 0} = ${pct(we.rate || 0)} (${pct(we.weightedRate || 0)}) | ${bw.errors || 0}/${bw.checked || 0} = ${pct(bw.rate || 0)} (${pct(bw.weightedRate || 0)}) | ${t.unverifiable} | ${t.pending} |`);
  }
  md.push('', `Critic missing (we show none, the page names one): ${missingCritic.length} (${missingCritic.join(', ')}).`);
  md.push('', `Soft score signal: both blind models put ${softScore.bothModelsOtherBucket}/${softScore.n} reviews in a different bucket than ours on the same side (adjacent-bucket disagreements are counted here, not as errors; an error needs a printed-rating band violation or a gap of 2+ buckets / 15+ points confirmed by reading).`, '');
  md.push('## Wrong items', '', '| Sample | Show | Outlet / critic | Check | Finding | Source | Critic Score now -> corrected |', '|---|---|---|---|---|---|---|');
  for (const w of wrong) for (const e of w.errors) {
    const im = impact[w.showId];
    md.push(`| ${w.sampleId} | ${w.showId} | ${w.outlet} / ${w.criticName || '-'} | ${e.check} | ${(e.note || '').replace(/\|/g, '/')} | ${e.sourceUrl || '-'} | ${im ? `${im.published} -> ${im.corrected} (${im.delta >= 0 ? '+' : ''}${im.delta})` : 'no score change'} |`);
  }
  fs.writeFileSync(path.join(AUDIT, 'report.md'), md.join('\n') + '\n');
  console.log(md.slice(0, 12).join('\n'));
}

if (require.main === module) main();
module.exports = { wilson, finalVerdict, showImpact };
