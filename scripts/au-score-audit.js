#!/usr/bin/env node
'use strict';
/**
 * au-score-audit.js (BRO-8433): read-only audit of the Australian regional shows.
 * Lists each AU show's live Critic Score (slim `cs`), and every review-text file
 * (file name, outlet, tier, score, flags). No review text is printed, so it is safe
 * to run through cloud-run-script.js --review-texts and read the output.
 *
 * Usage: node scripts/au-score-audit.js [--show=<id>] [--json]
 */
const fs = require('fs');
const path = require('path');
const { getRegionalCountry } = require('./lib/market-label.js');
const { getTier } = require('./lib/outlet-tiers.js');

const ROOT = path.join(__dirname, '..');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const only = arg('show');
const asJson = process.argv.includes('--json');

const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
const list = Array.isArray(shows) ? shows : shows.shows;
const au = list.filter((s) => s.category === 'regional' && getRegionalCountry(s.venue) === 'AU' && (!only || s.id === only));

const out = [];
for (const s of au) {
  let cs = null;
  try { cs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/shows', `${s.id}.json`), 'utf8')).cs ?? null; } catch {}
  const dir = path.join(ROOT, 'data/review-texts', s.id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const reviews = files.map((f) => {
    let j = {};
    let parseError = false;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { parseError = true; }
    const oid = typeof j.outletId === 'string' ? j.outletId : '';
    return {
      file: f, outletId: oid, tier: oid ? getTier(oid, { showCategory: 'regional' }) : null,
      assigned: typeof j.assignedScore === 'number' ? j.assignedScore : null,
      stars: typeof j.originalRating === 'string' ? j.originalRating : null,
      flags: [parseError && 'PARSE-ERROR', ...['wrongProduction', 'wrongShow', 'isRoundupArticle', 'excludeFromScoring'].filter((k) => j[k])].filter(Boolean),
    };
  });
  out.push({ id: s.id, status: s.status, venue: s.venue, cs, reviewCount: reviews.length, reviews });
}
if (asJson) console.log(JSON.stringify(out, null, 1));
else for (const s of out) {
  console.log(`\n== ${s.id} [${s.status}] cs=${s.cs} files=${s.reviewCount}`);
  for (const r of s.reviews) console.log(`  T${r.tier} ${String(r.outletId).padEnd(28)} assigned=${r.assigned} stars=${r.stars || '-'} ${r.flags.join(',')}  ${r.file}`);
}
