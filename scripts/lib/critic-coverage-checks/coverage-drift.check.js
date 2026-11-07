/**
 * coverage-drift.check.js
 *
 * Detects a >10% spike in totalGaps relative to the 4-week rolling average.
 * Fires a Discord alert via discord-notify.js and updates a cooldown file to
 * prevent alert storms (7-day cooldown between fires).
 *
 * Algorithm:
 *   1. Read last 5 snapshots from data/audit/critic-coverage-history/ (sorted desc)
 *   2. "Prior 4" = snapshots[1..4] (excluding the most recent)
 *   3. Compute 4-week rolling avg of totalGaps from prior 4
 *   4. If (current - avg) / avg > 0.10 → alert
 *   5. Respect 7-day cooldown via data/audit/critic-coverage-cooldown.json
 *
 * CLI:
 *   node scripts/lib/critic-coverage-checks/coverage-drift.check.js [--dry-run]
 *
 * Env:
 *   DISCORD_WEBHOOK_ALERTS — Discord webhook URL (read by discord-notify.js)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '../../../data/audit/critic-coverage-history');
const COOLDOWN_FILE = path.join(__dirname, '../../../data/audit/critic-coverage-cooldown.json');
const COOLDOWN_DAYS = 7;
const DRIFT_THRESHOLD = 0.10; // 10%
const MIN_SNAPSHOTS = 5;

// Require relative to this file so the path works from any cwd.
const { sendAlert } = require('../discord-notify');

/**
 * Read and sort snapshot files descending (newest first).
 * Returns array of parsed snapshot objects.
 */
function loadSnapshots() {
  if (!fs.existsSync(HISTORY_DIR)) {
    return [];
  }

  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse(); // newest filename first (ISO-sortable)

  const snapshots = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8');
      const parsed = JSON.parse(raw);
      snapshots.push({ file, ...parsed });
    } catch (err) {
      console.warn(`[drift-check] Skipping malformed snapshot ${file}: ${err.message}`);
    }
  }
  return snapshots;
}

/**
 * Read cooldown state. Returns null if file doesn't exist or is malformed.
 */
function readCooldown() {
  if (!fs.existsSync(COOLDOWN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if we're within the cooldown window.
 * Returns true if the last fire was <COOLDOWN_DAYS ago.
 */
function isCooldownActive(cooldown) {
  if (!cooldown || !cooldown.lastFiredAt) return false;
  const lastFired = new Date(cooldown.lastFiredAt);
  if (isNaN(lastFired.getTime())) return false;
  const msSinceFire = Date.now() - lastFired.getTime();
  const daysSinceFire = msSinceFire / (1000 * 60 * 60 * 24);
  return daysSinceFire < COOLDOWN_DAYS;
}

/**
 * Write cooldown file with current timestamp.
 */
function writeCooldown() {
  const state = { lastFiredAt: new Date().toISOString() };
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(`[drift-check] Cooldown updated: ${state.lastFiredAt}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('[drift-check] DRY RUN — no Discord post, no cooldown write');
  }

  // 1. Load snapshots
  const snapshots = loadSnapshots();

  if (snapshots.length < MIN_SNAPSHOTS) {
    console.log(`[drift-check] Insufficient history (need ${MIN_SNAPSHOTS} snapshots, have ${snapshots.length}), skipping`);
    process.exit(0);
  }

  // 2. Split: current = snapshots[0], prior 4 = snapshots[1..4]
  const current = snapshots[0];
  const prior4 = snapshots.slice(1, 5);

  const currentGaps = current.totalGaps;
  const avgPrior4 = prior4.reduce((sum, s) => sum + s.totalGaps, 0) / prior4.length;

  console.log(`[drift-check] Current totalGaps: ${currentGaps}`);
  console.log(`[drift-check] Prior-4 avg totalGaps: ${avgPrior4.toFixed(1)} (from snapshots: ${prior4.map(s => s.file).join(', ')})`);

  if (avgPrior4 === 0) {
    console.log('[drift-check] Prior-4 avg is 0 — cannot compute drift ratio, skipping');
    process.exit(0);
  }

  const driftRatio = (currentGaps - avgPrior4) / avgPrior4;
  const driftPct = (driftRatio * 100).toFixed(1);
  console.log(`[drift-check] Drift ratio: ${driftPct}% (threshold: ${DRIFT_THRESHOLD * 100}%)`);

  if (driftRatio <= DRIFT_THRESHOLD) {
    console.log('[drift-check] Drift within threshold — no alert needed');
    process.exit(0);
  }

  console.log(`[drift-check] DRIFT DETECTED: ${driftPct}% spike above 4-week rolling avg`);

  // 3. Check cooldown
  const cooldown = readCooldown();
  if (isCooldownActive(cooldown)) {
    console.log(`[drift-check] Drift cooldown active (last fired: ${cooldown.lastFiredAt}), skipping`);
    process.exit(0);
  }

  // 4. Prepare alert payload
  const topCritics = Object.entries(current.perCritic || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');

  const alertTitle = 'Critic coverage drift';
  const alertDescription =
    `Critic-coverage gaps spiked **${driftPct}%** above the 4-week rolling average.\n` +
    `Current \`totalGaps\`: **${currentGaps}** | Prior-4 avg: **${avgPrior4.toFixed(0)}**\n` +
    `Snapshot: \`${current.file}\` (${current.date || current.timestamp})`;

  const alertFields = [
    { name: 'Current gaps', value: String(currentGaps), inline: true },
    { name: 'Prior-4 avg', value: avgPrior4.toFixed(0), inline: true },
    { name: 'Drift', value: `${driftPct}%`, inline: true },
    { name: 'Top gap critics', value: topCritics || 'n/a', inline: false },
  ];

  if (dryRun) {
    console.log('[drift-check] DRY RUN — would call sendAlert with:');
    console.log(JSON.stringify({
      severity: 'warning',
      title: alertTitle,
      description: alertDescription,
      fields: alertFields,
    }, null, 2));
    console.log('[drift-check] DRY RUN — cooldown file NOT written');
    process.exit(0);
  }

  // 5. Fire alert
  console.log('[drift-check] Firing Discord alert...');
  try {
    await sendAlert({
      severity: 'warning',
      title: alertTitle,
      description: alertDescription,
      fields: alertFields,
    });
  } catch (err) {
    // Alert failure is non-fatal for cooldown update — log and continue.
    console.error(`[drift-check] Discord alert error: ${err.message}`);
    process.stdout.write(`::warning::Discord webhook failed (${err.message}) — cooldown still written, alert suppressed for 7 days\n`);
  }

  // 6. Update cooldown
  writeCooldown();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[drift-check] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { loadSnapshots, readCooldown, isCooldownActive, writeCooldown };
