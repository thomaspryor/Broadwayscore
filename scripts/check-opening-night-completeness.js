#!/usr/bin/env node
/**
 * check-opening-night-completeness.js
 *
 * Per-critic drop detector for shows in the opening-night window
 * (status=open AND |today - openingDate| ≤ 7d).
 *
 * Compares the current critic set in reviews.json against a snapshot from the
 * previous run. Any critic that disappears, any review-count regression, and
 * any score-source regression for an opening-night show fires a Discord alert.
 *
 * Designed to run on:
 *   1. 15-min cron (opening-night-completeness-check.yml) — between rebuilds
 *   2. As a step in rebuild-fast.yml + rebuild-reviews.yml — to also surface
 *      per-show drops from data/audit/rebuild-regression.json the moment a
 *      rebuild produces them (A #20).
 *
 * State file: data/audit/opening-night-completeness-state.json
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-04-26T...",
 *     "shows": {
 *       "<showId>": {
 *         "openingDate": "2026-04-25",
 *         "snapshot": [{ "outletId": "x", "criticName": "y", "url": "z", "scored": true }],
 *         "lastAlertAt": "2026-04-26T..."   // per-show 60-min cooldown
 *       }
 *     }
 *   }
 *
 * CLI:
 *   node scripts/check-opening-night-completeness.js
 *   node scripts/check-opening-night-completeness.js --dry-run
 *   node scripts/check-opening-night-completeness.js --force          (bypass cooldown)
 *   node scripts/check-opening-night-completeness.js --window-days=7
 *   node scripts/check-opening-night-completeness.js --show=joe-turners-come-and-gone-2026
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { sendAlert } = require('./lib/discord-notify');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const STATE_FILE = path.join(AUDIT_DIR, 'opening-night-completeness-state.json');
const REBUILD_REGRESSION_FILE = path.join(AUDIT_DIR, 'rebuild-regression.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;
const WINDOW_DAYS = parseInt((args.find(a => a.startsWith('--window-days=')) || '').replace('--window-days=', ''), 10) || 7;

const COOLDOWN_MS = 60 * 60 * 1000;            // 60 min per-show
const REGRESSION_FRESH_MS = 30 * 60 * 1000;    // only consult rebuild-regression.json if written in last 30 min

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isWithinWindow(openingDate, now, windowDays) {
  if (!openingDate) return false;
  const diff = Math.abs(new Date(openingDate).getTime() - now.getTime());
  return diff <= windowDays * 24 * 60 * 60 * 1000;
}

function criticKey(r) {
  // Identity = outlet + critic. Fall back to URL when criticName is missing.
  const outlet = (r.outletId || '').toLowerCase();
  const critic = (r.criticName || '').toLowerCase().trim();
  if (outlet && critic) return `${outlet}|${critic}`;
  if (outlet && r.url) return `${outlet}|url:${r.url.toLowerCase()}`;
  if (r.url) return `url:${r.url.toLowerCase()}`;
  return `${outlet || 'unknown'}|anonymous`;
}

function isScored(r) {
  // assignedScore is the rebuild's resolved score. scoreSource tells us where
  // it came from (llmScore, humanReviewScore, llmConsensus, etc.). Either signal
  // means the review will display a number on the live page.
  return r.assignedScore != null && r.assignedScore !== '';
}

function buildCriticSet(reviews) {
  const map = new Map();
  for (const r of reviews) {
    const key = criticKey(r);
    // Prefer scored entry over unscored if duplicates exist (rare but possible
    // if the same critic appears twice with different URLs)
    const existing = map.get(key);
    if (!existing || (!existing.scored && isScored(r))) {
      map.set(key, {
        outletId: r.outletId || null,
        criticName: r.criticName || null,
        url: r.url || null,
        scored: isScored(r),
      });
    }
  }
  return map;
}

function loadState() {
  const state = loadJSON(STATE_FILE, { version: 1, updatedAt: null, shows: {} });
  if (!state.shows) state.shows = {};
  return state;
}

function saveState(state) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ─── Diff ────────────────────────────────────────────────────────────────────

/**
 * Given previous + current critic snapshots for one show, compute drops.
 * Returns null if nothing dropped, else { droppedCritics, lostScores, countDelta }.
 */
function diffShow(prevSnapshot, currentMap) {
  if (!Array.isArray(prevSnapshot) || prevSnapshot.length === 0) return null;

  const prevMap = new Map(prevSnapshot.map(c => [
    criticKey({ outletId: c.outletId, criticName: c.criticName, url: c.url }),
    c,
  ]));

  const droppedCritics = [];   // present before, absent now
  const lostScores = [];       // present both runs, but score was there before and isn't now

  for (const [key, prev] of prevMap) {
    const cur = currentMap.get(key);
    if (!cur) {
      droppedCritics.push(prev);
    } else if (prev.scored && !cur.scored) {
      lostScores.push({ ...cur, _previousScored: true });
    }
  }

  const countDelta = currentMap.size - prevMap.size;

  if (droppedCritics.length === 0 && lostScores.length === 0 && countDelta >= 0) {
    return null;
  }

  return { droppedCritics, lostScores, countDelta, prevCount: prevMap.size, curCount: currentMap.size };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();

  const showsDoc = loadJSON(SHOWS_FILE);
  if (!showsDoc) {
    console.error('Could not read shows.json — aborting');
    process.exit(1);
  }
  const shows = showsDoc.shows || showsDoc;

  const reviewsDoc = loadJSON(REVIEWS_FILE);
  if (!reviewsDoc) {
    console.error('Could not read reviews.json — aborting');
    process.exit(1);
  }
  const allReviews = reviewsDoc.reviews || [];

  // Group reviews by showId once
  const reviewsByShow = new Map();
  for (const r of allReviews) {
    if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
    reviewsByShow.get(r.showId).push(r);
  }

  // Resolve target shows
  let targets;
  if (SHOW_FILTER) {
    const show = shows.find(s => s.id === SHOW_FILTER);
    targets = show ? [show] : [];
    if (!show) console.error(`[completeness] --show=${SHOW_FILTER} not in shows.json`);
  } else {
    targets = shows.filter(s => s.status === 'open' && isWithinWindow(s.openingDate, now, WINDOW_DAYS));
  }

  if (targets.length === 0) {
    console.log('[completeness] No shows in opening-night window — nothing to check.');
    process.exit(0);
  }

  console.log(`[completeness] Checking ${targets.length} opening-night show(s) (±${WINDOW_DAYS}d window).`);

  // Optional: pull fresh per-show drops from rebuild-regression.json
  // (only if it was written in the last 30 min — otherwise it's stale).
  const regressionDoc = loadJSON(REBUILD_REGRESSION_FILE);
  const freshRegressions = new Map();
  if (regressionDoc?.timestamp) {
    const ageMs = now.getTime() - new Date(regressionDoc.timestamp).getTime();
    if (ageMs >= 0 && ageMs <= REGRESSION_FRESH_MS) {
      for (const r of regressionDoc.regressions || []) {
        freshRegressions.set(r.showId, r);
      }
      if (freshRegressions.size > 0) {
        console.log(`[completeness] Including ${freshRegressions.size} fresh per-show regression(s) from rebuild-regression.json (age ${Math.round(ageMs / 1000)}s).`);
      }
    }
  }

  const state = loadState();
  const alerts = [];        // shows needing alert this run
  const seenIds = new Set();

  for (const show of targets) {
    seenIds.add(show.id);
    const showReviews = reviewsByShow.get(show.id) || [];
    const currentMap = buildCriticSet(showReviews);

    const prev = state.shows[show.id];
    const diff = prev ? diffShow(prev.snapshot || [], currentMap) : null;
    const regression = freshRegressions.get(show.id) || null;

    // Always update snapshot for next run
    const newEntry = {
      openingDate: show.openingDate,
      snapshot: Array.from(currentMap.values()),
      lastAlertAt: prev?.lastAlertAt || null,
    };
    state.shows[show.id] = newEntry;

    // Alert decision: any drop OR any score regression OR fresh per-show regression
    const hasDiffDrop = diff && (diff.droppedCritics.length > 0 || diff.lostScores.length > 0 || diff.countDelta < 0);
    const hasFreshRegression = regression && regression.dropped > 0;

    if (!hasDiffDrop && !hasFreshRegression) continue;

    // Cooldown
    if (!FORCE && newEntry.lastAlertAt) {
      const sinceMs = now.getTime() - new Date(newEntry.lastAlertAt).getTime();
      if (sinceMs < COOLDOWN_MS) {
        const minutesLeft = Math.ceil((COOLDOWN_MS - sinceMs) / 60000);
        console.log(`[completeness] ${show.id}: drop detected but in cooldown (${minutesLeft}m left). Use --force to send.`);
        continue;
      }
    }

    alerts.push({ show, diff, regression });
    if (!DRY_RUN) newEntry.lastAlertAt = now.toISOString();
  }

  // Garbage-collect snapshots for shows no longer in window (unless filtered)
  if (!SHOW_FILTER) {
    for (const id of Object.keys(state.shows)) {
      if (!seenIds.has(id)) delete state.shows[id];
    }
  }

  // Emit alerts (single Discord message summarizing all shows in this run)
  if (alerts.length > 0) {
    console.log(`[completeness] ${alerts.length} show(s) need an alert this run.`);
    const fields = alerts.map(({ show, diff, regression }) => {
      const lines = [];
      if (diff) {
        lines.push(`Reviews: ${diff.prevCount} → ${diff.curCount} (Δ ${diff.countDelta >= 0 ? '+' : ''}${diff.countDelta})`);
        if (diff.droppedCritics.length > 0) {
          const sample = diff.droppedCritics.slice(0, 5)
            .map(c => `${c.outletId || '?'}/${c.criticName || 'anonymous'}`).join(', ');
          lines.push(`Dropped critics (${diff.droppedCritics.length}): ${sample}${diff.droppedCritics.length > 5 ? '…' : ''}`);
        }
        if (diff.lostScores.length > 0) {
          const sample = diff.lostScores.slice(0, 5)
            .map(c => `${c.outletId || '?'}/${c.criticName || 'anonymous'}`).join(', ');
          lines.push(`Lost scores (${diff.lostScores.length}): ${sample}${diff.lostScores.length > 5 ? '…' : ''}`);
        }
      }
      if (regression) {
        lines.push(`Rebuild regression: ${regression.oldCount}→${regression.newCount} (-${regression.dropped})${regression.reason ? ` [${regression.reason}]` : ''}`);
      }
      return {
        name: `${show.title || show.id}`,
        value: lines.join('\n') || 'drop detected',
        inline: false,
      };
    });

    const description = `${alerts.length} opening-night show(s) had review/critic/score drops between checks. Investigate before next deploy — drops on opening-night shows are usually a stripping bug, not a quality flag.`;

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Would send Discord alert:');
      console.log('Title: Opening-Night Drop Alert');
      console.log('Description:', description);
      for (const f of fields) {
        console.log(`\n— ${f.name} —`);
        console.log(f.value);
      }
    } else if (!process.env.DISCORD_WEBHOOK_ALERTS) {
      console.warn('[completeness] DISCORD_WEBHOOK_ALERTS not set — skipping alert dispatch.');
    } else {
      const ok = await sendAlert({
        title: `Opening-Night Drop Alert — ${alerts.length} show(s)`,
        description,
        severity: 'warning',
        fields,
        url: `https://github.com/${process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore'}/actions`,
      });
      console.log(`[completeness] Discord alert dispatch: ${ok ? 'sent' : 'FAILED'}`);
    }
  } else {
    console.log('[completeness] No drops detected — opening-night shows look complete vs last snapshot.');
  }

  // Persist updated state (cooldown timestamps + new snapshots)
  if (!DRY_RUN) {
    saveState(state);
    console.log(`[completeness] State updated: ${Object.keys(state.shows).length} show(s) tracked.`);
  } else {
    console.log('[DRY RUN] Snapshot file NOT written.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[completeness] Fatal:', err.stack || err.message);
  process.exit(1);
});
