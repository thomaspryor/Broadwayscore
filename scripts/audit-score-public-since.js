#!/usr/bin/env node
/**
 * audit-score-public-since.js — Coverage Verdict S3 (task #905): stamps the
 * first time each show's Critic Score goes public, into
 * data/audit/score-public-since.json. This is the timestamp data-core.ts
 * reads to apply the score-regression floor (src/config/score-buckets.ts's
 * applyCoverageFloor) — once a stamp is >24h old, the show's score is shown
 * regardless of any later verdict change or review-count dip.
 *
 * Source of truth: the `cs` field on public/data/shows/{id}.json (written by
 * generate-mobile-show-details.js's own hasEnoughReviews-equivalent gate —
 * the same field CLAUDE.md's canonical-critic-scores.ts already trusts as
 * "is this show's score currently public"). Append-only: a stamp is never
 * removed, even if `cs` later goes null again — see
 * scripts/lib/score-public-since.js for why.
 *
 *   node scripts/audit-score-public-since.js               write the stamp file
 *   node scripts/audit-score-public-since.js --dry-run      print, don't write
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { computeScorePublicSinceUpdates } = require('./lib/score-public-since.js');

const REPO = path.join(__dirname, '..');
const SLIM_DIR = path.join(REPO, 'public', 'data', 'shows');
const STAMP_PATH = path.join(REPO, 'data', 'audit', 'score-public-since.json');

function loadCsByShowId() {
  const out = {};
  let files;
  try { files = fs.readdirSync(SLIM_DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SLIM_DIR, f), 'utf8'));
      out[id] = typeof j.cs === 'number' ? j.cs : null;
    } catch {
      out[id] = null;
    }
  }
  return out;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const nowIso = new Date().toISOString();

  let prevStamps = {};
  try { prevStamps = JSON.parse(fs.readFileSync(STAMP_PATH, 'utf8')); } catch { /* first run */ }

  const csByShowId = loadCsByShowId();
  const { stamps, newlyStamped } = computeScorePublicSinceUpdates(prevStamps, csByShowId, nowIso);

  console.log(`[score-public-since] ${newlyStamped.length} show(s) newly stamped, ${Object.keys(stamps).length} total`);
  if (newlyStamped.length) console.log(`  ${newlyStamped.slice(0, 20).join(', ')}${newlyStamped.length > 20 ? ', …' : ''}`);

  if (dryRun) {
    console.log('[score-public-since] --dry-run, not writing');
    return;
  }
  if (newlyStamped.length === 0) {
    console.log('[score-public-since] no changes, skipping write');
    return;
  }
  fs.mkdirSync(path.dirname(STAMP_PATH), { recursive: true });
  fs.writeFileSync(`${STAMP_PATH}.tmp`, JSON.stringify(stamps, null, 2) + '\n');
  fs.renameSync(`${STAMP_PATH}.tmp`, STAMP_PATH);
  console.log(`[score-public-since] wrote ${STAMP_PATH}`);
}

if (require.main === module) main();

module.exports = { loadCsByShowId };
