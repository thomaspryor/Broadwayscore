#!/usr/bin/env node
/**
 * Remove Theatr audience data attached to shows that closed before Theatr had
 * users (BRO-5276). See scripts/lib/theatr-stale-attachment.js for why those
 * scores belong to a different, modern production of the same title.
 *
 * Companion to the matchTheatrToShows guard (which stops new attachments) and
 * the OTHER_SOURCE_STALE audit signal (which finds them). Deletes
 * sources.theatr and recomputes combinedScore/designation from what remains,
 * exactly as the live weighting would.
 *
 * Usage:
 *   node scripts/neutralize-stale-theatr-buzz.js           # dry run
 *   node scripts/neutralize-stale-theatr-buzz.js --apply   # write
 */

const fs = require('fs');
const path = require('path');
const { closedBeforeTheatr } = require('./lib/theatr-stale-attachment');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { removeSourceWithTombstone } = require('./lib/reconcile-audience-buzz');

const ROOT = path.join(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

/**
 * Pure planner: which buzz rows lose Theatr, and what their score becomes.
 * @returns {Array<{id: string, rc: number, before: number|null, after: number|null, designation: string|null}>}
 */
function planStaleTheatrRemoval(buzzShows, shows) {
  const showById = new Map(shows.map((s) => [s.id, s]));
  const plan = [];
  for (const [id, rec] of Object.entries(buzzShows || {})) {
    const theatr = rec && rec.sources && rec.sources.theatr;
    if (!theatr) continue;
    const show = showById.get(id);
    if (!closedBeforeTheatr(show)) continue;
    const remaining = { ...rec.sources };
    delete remaining.theatr;
    const showInfo = { status: show.status, closingDate: show.closingDate, category: show.category };
    const { score } = calculateCombinedScore(remaining, showInfo);
    plan.push({
      id,
      rc: theatr.reviewCount || 0,
      before: rec.combinedScore ?? null,
      after: score ?? null,
      designation: score == null ? null : getDesignation(score),
    });
  }
  return plan.sort((a, b) => a.id.localeCompare(b.id));
}

/** Mutates buzzShows: drops sources.theatr, leaves the tombstone, stores the recomputed score. */
function applyStaleTheatrRemoval(buzzShows, plan) {
  for (const p of plan) {
    const rec = buzzShows[p.id];
    removeSourceWithTombstone(rec, 'theatr', 'closed before Theatr existed (BRO-5276)');
    rec.combinedScore = p.after;
    rec.designation = p.designation;
  }
}

function main() {
  const apply = process.argv.includes('--apply');
  const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');
  const buzz = loadAudienceBuzz();
  const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8')).shows || [];
  const plan = planStaleTheatrRemoval(buzz.shows, shows);
  console.log(`[neutralize-stale-theatr] ${plan.length} shows ${apply ? 'CLEANED' : '(dry run, use --apply)'}`);
  for (const p of plan) console.log(`  ${p.id} theatr rc=${p.rc} | combinedScore ${p.before} -> ${p.after}`);
  if (!apply || plan.length === 0) return;
  applyStaleTheatrRemoval(buzz.shows, plan);
  buzz._meta = buzz._meta || {};
  saveAudienceBuzz(buzz);
  console.log('Wrote data/audience-buzz.json');
}

module.exports = { planStaleTheatrRemoval, applyStaleTheatrRemoval };
if (require.main === module) main();
