#!/usr/bin/env node
/**
 * Remove Show Score data that came from another production's page (BRO-5866).
 *
 * Show Score keeps one page per production and a same-title production reuses
 * the plain slug, so Safe House (Theatre Row, 2026) was mapped to the 2025
 * St. Ann's Warehouse page and carried its 63% audience score. The page's
 * review dates are the evidence (lib/show-score-production-window.js): nearly
 * all of them fall outside this production's run.
 *
 * For each such show: drop the mapping from show-score-urls.json and record
 * it under _productionMismatch (so no writer maps it back), drop the
 * show-score.json entry, and remove sources.showScore from audience-buzz.json
 * (tombstoned) with combinedScore/designation recomputed. Shows already
 * recorded under _productionMismatch are included, which is how a run in
 * execute-approved-fix.yml cleans the private audience-buzz.json after the
 * public files were cleaned in the PR. A show mapped again since then is
 * judged by the sweep alone, so a page that now passes keeps its data.
 *
 * Usage:
 *   node scripts/purge-wrong-production-show-score.js            # dry run
 *   node scripts/purge-wrong-production-show-score.js --apply    # write
 *   node scripts/purge-wrong-production-show-score.js --strict   # dry run, exit 1 when anything is found
 */
const fs = require('fs');
const path = require('path');
const { planWrongProductionPurge, applyWrongProductionPurge } = require('./lib/show-score-wrong-production');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ARCHIVE_DIR = path.join(DATA, 'aggregator-archive', 'show-score');

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function main() {
  require('./lib/cli-help').exitOnHelp(module);
  const apply = process.argv.includes('--apply');
  const urlsPath = path.join(DATA, 'show-score-urls.json');
  const scoreDataPath = path.join(DATA, 'show-score.json');
  const urlData = readJson(urlsPath);
  const showScoreData = readJson(scoreDataPath);
  const shows = (readJson(path.join(DATA, 'shows.json')) || {}).shows || [];
  if (!urlData || shows.length === 0) {
    console.error('[purge-wrong-production-show-score] show-score-urls.json or shows.json missing; nothing checked');
    process.exitCode = 1;
    return;
  }
  const showsById = {};
  for (const s of shows) showsById[s.id] = s;
  // audience-buzz.json is private core data: absent in a public-only checkout.
  let audienceBuzz = null;
  let saveAudienceBuzz = null;
  if (fs.existsSync(path.join(DATA, 'audience-buzz.json'))) {
    const guard = require('./lib/audience-buzz-write-guard');
    audienceBuzz = guard.loadAudienceBuzz();
    saveAudienceBuzz = guard.saveAudienceBuzz;
  }
  const readArchive = (id) => {
    const f = path.join(ARCHIVE_DIR, `${id}.html`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };

  const plan = planWrongProductionPurge({ urlData, showScoreData, audienceBuzz, showsById, readArchive });
  console.log(`[purge-wrong-production-show-score] ${plan.length} shows ${apply ? 'CLEANED' : '(dry run, use --apply)'}`);
  if (process.argv.includes('--strict') && !apply && plan.length > 0) process.exitCode = 1;
  if (!apply) {
    for (const p of plan) console.log(`  ${p.showId}: ${p.url}\n    ${p.reason} [${p.evidence}]`);
    return;
  }
  if (plan.length === 0) return;
  const done = applyWrongProductionPurge(plan, { urlData, showScoreData, audienceBuzz, showsById });
  for (const d of done) {
    console.log(`  ${d.showId}: mapping ${d.mappingRemoved ? 'removed' : '-'}, critics ${d.criticsRemoved ? 'removed' : '-'}, audience ${d.audienceRemoved ? `removed (combinedScore now ${d.combinedScore})` : '-'}`);
  }
  urlData._meta = { ...(urlData._meta || {}), lastUpdated: new Date().toISOString() };
  fs.writeFileSync(urlsPath, JSON.stringify(urlData, null, 2) + '\n');
  console.log('Wrote data/show-score-urls.json');
  if (showScoreData && done.some((d) => d.criticsRemoved)) {
    fs.writeFileSync(scoreDataPath, JSON.stringify(showScoreData, null, 2));
    console.log('Wrote data/show-score.json');
  }
  if (audienceBuzz && done.some((d) => d.audienceRemoved)) {
    saveAudienceBuzz(audienceBuzz);
    console.log('Wrote data/audience-buzz.json');
  }
}

if (require.main === module) main();
