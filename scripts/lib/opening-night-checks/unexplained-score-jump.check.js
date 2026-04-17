'use strict';

const fs = require('fs');
const path = require('path');

const name = 'unexplained-score-jump';
const description = 'Composite score jumped >8pts since yesterday with no new reviews added';

const JUMP_THRESHOLD = 8;
const DEFAULT_SNAPSHOT_FILE = path.resolve(__dirname, '../../../data/audit/score-history.jsonl');

/**
 * Read the last two distinct date entries for a show from the snapshot JSONL.
 * @param {string} showId
 * @param {string} snapshotFile
 * @returns {{ today: Object|null, yesterday: Object|null }}
 */
function readLastTwoSnapshots(showId, snapshotFile) {
  if (!fs.existsSync(snapshotFile)) return { today: null, yesterday: null };

  const lines = fs.readFileSync(snapshotFile, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.showId === showId) entries.push(entry);
    } catch (_) {}
  }

  // Sort descending by date, get last two distinct dates
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, e);
  }

  const dates = Array.from(byDate.keys()).sort().reverse();
  return {
    today: dates[0] ? byDate.get(dates[0]) : null,
    yesterday: dates[1] ? byDate.get(dates[1]) : null,
  };
}

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @param {string} [snapshotFile] - Override for testing
 * @returns {import('./types').CheckResult}
 */
function run(show, context, snapshotFile = DEFAULT_SNAPSHOT_FILE) {
  const { today, yesterday } = readLastTwoSnapshots(show.id, snapshotFile);

  if (!today || !yesterday) {
    return {
      ok: true,
      severity: 'ok',
      message: `Fewer than 2 daily snapshots for ${show.id} — score jump check not yet available`,
    };
  }

  if (today.compositeScore == null || yesterday.compositeScore == null) {
    return { ok: true, severity: 'ok', message: 'One or both snapshots have null compositeScore — skipping jump check' };
  }

  const scoreDelta = today.compositeScore - yesterday.compositeScore;
  const reviewDelta = (today.reviewCount ?? 0) - (yesterday.reviewCount ?? 0);

  if (Math.abs(scoreDelta) > JUMP_THRESHOLD && reviewDelta === 0) {
    return {
      ok: false,
      severity: 'warning',
      message: `Composite jumped ${scoreDelta > 0 ? '+' : ''}${scoreDelta} pts (${yesterday.compositeScore}→${today.compositeScore}) with 0 new reviews — investigate rescore / content change`,
      details: { scoreDelta, reviewDelta, today, yesterday },
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `Score change: ${scoreDelta > 0 ? '+' : ''}${scoreDelta} pts with ${reviewDelta} new review(s) — within expected range`,
    details: { scoreDelta, reviewDelta },
  };
}

module.exports = { name, description, run, readLastTwoSnapshots };
