#!/usr/bin/env node
'use strict';
/**
 * Why is an ingested review file not on the live site? (BRO-7817)
 *
 * Reads a list of {show, file, url} (default data/audit/bro-7817-not-live-input.json), loads each
 * review-text file, and prints the includability verdict from review-guards.explainExclusion (the single
 * rule chain the rebuild uses) plus the fields that explain it. Read-only. Needs data/review-texts, so in
 * cloud run it through: node scripts/cloud-run-script.js --review-texts scripts/triage-ingested-not-live.js
 *
 * Usage: node scripts/triage-ingested-not-live.js [--input=<json>] [--json]
 */
const fs = require('fs');
const path = require('path');
const { explainExclusion } = require('./lib/review-guards');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { loadShowsById, loadRebuildExclusions } = require('./exclusion-rule-census');

const ROOT = path.join(__dirname, '..');

function summarize(data) {
  const text = typeof data.fullText === 'string' ? data.fullText : '';
  return {
    outlet: data.outletId,
    critic: data.criticName,
    textChars: text.length,
    contentTier: data.contentTier || null,
    wrongProduction: data.wrongProduction === true,
    wrongProductionReason: data.wrongProductionReason || null,
    wrongShow: data.wrongShow === true,
    isRoundupArticle: data.isRoundupArticle === true,
    scored: [data.assignedScore, data.llmScore && data.llmScore.score, data.score].find((v) => typeof v === 'number') ?? null,
    publishDate: data.publishDate || data.date || null,
    flagged: Object.keys(data).filter((k) => /^(wrong|isRound|nonReview|duplicateOf|rejection|excluded)/.test(k) && data[k]),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const inputPath = (argv.find((a) => a.startsWith('--input=')) || '').slice(8) || path.join(ROOT, 'data/audit/bro-7817-not-live-input.json');
  const asJson = argv.includes('--json');
  const dir = resolveReviewTextsDir();
  if (!dir || !fs.existsSync(dir)) { console.error('review-texts not available: cannot triage'); process.exit(1); }
  const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const showById = loadShowsById(path.join(ROOT, 'data/shows.json'));
  const rebuildLists = loadRebuildExclusions(path.join(ROOT, 'data/audit'));
  const out = [];
  for (const r of rows) {
    const fp = path.join(dir, r.show, r.file);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { out.push({ ...r, missing: true }); continue; }
    const show = showById[r.show];
    const rule = explainExclusion(data, show, fp);
    const list = Object.prototype.hasOwnProperty.call(rebuildLists, r.show) ? rebuildLists[r.show] : null;
    const aligned = list ? explainExclusion(data, show, fp, { rebuildExclusions: list }) : rule;
    out.push({ ...r, rule, aligned, showInCatalog: !!show, showStatus: show && show.status, ...summarize(data) });
  }
  if (asJson) { console.log(JSON.stringify(out, null, 1)); return; }
  const by = {};
  for (const o of out) { const k = o.missing ? 'file-missing' : (o.aligned || o.rule || 'includable'); (by[k] = by[k] || []).push(o); }
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n== ${k}: ${v.length}`);
    for (const o of v) console.log(`  ${o.show} | ${o.outlet || ''} | scored=${o.scored} chars=${o.textChars} wp=${o.wrongProduction}${o.wrongProductionReason ? ' (' + String(o.wrongProductionReason).slice(0, 70) + ')' : ''} | ${o.file}`);
  }
}

if (require.main === module) main();
module.exports = { summarize };
