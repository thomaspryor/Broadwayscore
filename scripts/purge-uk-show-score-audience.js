#!/usr/bin/env node
/**
 * Remove Show Score audience data that came from a UK (London / West End /
 * Off-West End) Show Score page but sits on a US-market show (BRO-5499).
 *
 * Show Score serves the London page at the NYC slug when a transfer has no NYC
 * page yet (Midnight: canonical /uk/london/off-west-end-shows/midnight, 92% on
 * 351 London ratings). The archived page in data/aggregator-archive/show-score/
 * is the evidence: if its canonical is a UK page, the stored sources.showScore
 * for that US show is London's. Deletes sources.showScore (tombstoned) and
 * recomputes combinedScore/designation from what remains, as the live
 * weighting would. Companion to the isValidShowScorePage guard
 * (lib/show-score-canonical.js), which stops new attachments.
 *
 * Usage:
 *   node scripts/purge-uk-show-score-audience.js           # dry run
 *   node scripts/purge-uk-show-score-audience.js --apply   # write
 *   --strict  exit 1 when any US show still carries UK Show Score data (dry run)
 *   --alert   file/refresh one worker card via owner-alert-router, clear it when clean (BRO-7182, dry run only;
 *             no shows, no audience-buzz rows or no archive makes no decision)
 */
const fs = require('fs');
const path = require('path');
const { servesUkPageForUsShow, allowsUkShowScorePage, pageRatingOf, storedRatingMatchesPage } = require('./lib/show-score-canonical');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { removeSourceWithTombstone } = require('./lib/reconcile-audience-buzz');

const ROOT = path.join(__dirname, '..');
const ARCHIVE_DIR = (process.argv.find((a) => a.startsWith('--archive-dir=')) || '').slice(14)
  || path.join(ROOT, 'data', 'aggregator-archive', 'show-score');

/**
 * Pure planner.
 * @param {object} buzzShows audience-buzz.json `shows`
 * @param {Array<object>} shows shows.json entries
 * @param {(showId: string) => string|null} readArchive archived Show Score HTML for a show, or null
 */
function planUkShowScoreRemoval(buzzShows, shows, readArchive) {
  const plan = [];
  for (const show of shows) {
    // London shows, and regional shows at UK houses (Chichester, RSC), legitimately have a UK Show Score page
    if (allowsUkShowScorePage(show)) continue;
    const rec = buzzShows && buzzShows[show.id];
    if (!rec || !rec.sources || !rec.sources.showScore) continue;
    const html = readArchive(show.id);
    if (!html || !servesUkPageForUsShow(html.slice(0, 80000), '')) continue;
    // Only when the stored rating IS the UK page's rating: an archive overwritten later by a UK page
    // says nothing about a rating scraped earlier from the right page (Disruption: 90%/731 vs 81%/6).
    if (!storedRatingMatchesPage(rec.sources.showScore, pageRatingOf(html))) continue;
    const remaining = { ...rec.sources };
    delete remaining.showScore;
    const { score } = calculateCombinedScore(remaining, { status: show.status, closingDate: show.closingDate, category: show.category });
    plan.push({
      id: show.id,
      score: rec.sources.showScore.score,
      rc: rec.sources.showScore.reviewCount || 0,
      before: rec.combinedScore ?? null,
      after: score ?? null,
      designation: score == null ? null : getDesignation(score),
    });
  }
  return plan.sort((a, b) => a.id.localeCompare(b.id));
}

function applyUkShowScoreRemoval(buzzShows, plan) {
  for (const p of plan) {
    const rec = buzzShows[p.id];
    removeSourceWithTombstone(rec, 'showScore', 'Show Score page is a UK production page (canonical /uk/london/...) (BRO-5499)');
    rec.combinedScore = p.after;
    rec.designation = p.designation;
  }
}

async function main() {
  require('./lib/cli-help').exitOnHelp(module);
  const apply = process.argv.includes('--apply');
  const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');
  const buzz = loadAudienceBuzz();
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf-8')).shows || [];
  const readArchive = (id) => {
    const f = path.join(ARCHIVE_DIR, `${id}.html`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };
  const plan = planUkShowScoreRemoval(buzz.shows, shows, readArchive);
  console.log(`[purge-uk-show-score] ${plan.length} shows ${apply ? 'CLEANED' : '(dry run, use --apply)'}`);
  if (process.argv.includes('--strict') && !apply && plan.length > 0) process.exitCode = 1;
  if (process.argv.includes('--alert') && !apply) {
    const { decideUkShowScoreAlert } = require('./lib/strict-audit-alerts');
    const { routeAuditDecisions } = require('./lib/audit-alert');
    let archiveFiles = 0;
    try { archiveFiles = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.html')).length; } catch { archiveFiles = 0; }
    const decisions = decideUkShowScoreAlert({ plan, showsCount: shows.length, buzzCount: Object.keys((buzz && buzz.shows) || {}).length, archiveFiles });
    if (!decisions.length) console.log('[purge-uk-show-score] --alert skipped: shows, audience-buzz or the Show Score archive is missing');
    await routeAuditDecisions(decisions, 'purge-uk-show-score-audience');
  }
  for (const p of plan) console.log(`  ${p.id} showScore ${p.score}%/${p.rc} | combinedScore ${p.before} -> ${p.after}`);
  if (!apply || plan.length === 0) return;
  applyUkShowScoreRemoval(buzz.shows, plan);
  buzz._meta = buzz._meta || {};
  saveAudienceBuzz(buzz);
  console.log('Wrote data/audience-buzz.json');
}

module.exports = { planUkShowScoreRemoval, applyUkShowScoreRemoval };
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 3; });
}
