#!/usr/bin/env node
/**
 * migrate-digest-scores-to-canonical.js — ONE-OFF migration (BRO score-
 * stability fix, 2026-08-31).
 *
 * detect-show-changes.js used to store a raw unweighted mean of
 * data/reviews.json as each show's `score` baseline in
 * data/audit/show-changes-digest.json. It now stores the canonical
 * tier-weighted Critic Score (public/data/shows/{id}.json's `cs`) instead —
 * see detect-show-changes.js's getCriticScore().
 *
 * Without this migration, the next scheduled run would diff the new
 * canonical score against the old raw-mean baseline for every show and
 * fire a wave of "Score changed" notifications caused purely by the
 * formula switch, not by anything actually happening with the show —
 * exactly the embarrassing false-positive this fix exists to stop.
 *
 * Run once, then delete. Safe to re-run (idempotent: overwrites with the
 * same canonical value each time).
 */
const fs = require('fs');
const path = require('path');

const DIGEST_PATH = path.join(__dirname, '..', 'data', 'audit', 'show-changes-digest.json');
const SLIM_DIR = path.join(__dirname, '..', 'public', 'data', 'shows');

function getCriticScore(showId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SLIM_DIR, `${showId}.json`), 'utf8'));
    return typeof j.cs === 'number' ? Math.round(j.cs * 10) / 10 : null;
  } catch {
    return null;
  }
}

const digest = JSON.parse(fs.readFileSync(DIGEST_PATH, 'utf8'));
let changed = 0;
for (const [showId, state] of Object.entries(digest.currentState || {})) {
  const canonical = getCriticScore(showId);
  if (canonical == null) continue;
  if (state.score !== canonical) {
    console.log(`${showId}: ${state.score} -> ${canonical}`);
    state.score = canonical;
    changed++;
  }
}

fs.writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2) + '\n');
console.log(`\nMigrated ${changed} show score(s) to canonical.`);
