// Award Score Movers — shared logic for diffing two data/award-score-history/
// snapshots into ranked week-over-week deltas.
//
// Two call patterns:
//   - resolveMoversForWeek(): CLI contract (scripts/award-score-movers.js) —
//     requires an EXACT snapshot for --week-start and reports errors so a
//     human/cron invocation gets a clear message.
//   - latestMovers(): newsletter contract (scripts/newsletter/generate.mjs) —
//     no exact-date requirement, just diffs the two most recent available
//     snapshots. The weekly newsletter's week-start rarely lines up exactly
//     with the Saturday snapshot cron, and the newsletter just wants "what
//     changed since last time," not a specific calendar week.

'use strict';

const fs = require('fs');
const path = require('path');

function snapshotFilename(date, market) {
  return market === 'broadway' ? `${date}.json` : `${date}-${market}.json`;
}

function listAvailableDates(historyDir, market) {
  if (!fs.existsSync(historyDir)) return [];
  const suffix = market === 'broadway'
    ? /^(\d{4}-\d{2}-\d{2})\.json$/
    : new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${market}\\.json$`);
  return fs.readdirSync(historyDir)
    .map((f) => {
      const m = f.match(suffix);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();
}

function loadSnapshot(historyDir, date, market) {
  const p = path.join(historyDir, snapshotFilename(date, market));
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Pure diff of two snapshot payloads → ranked movers (biggest |delta| first).
// `badge` carries the AFTER snapshot's tier (falls back to BEFORE's) so a
// display layer can color the mover by its current award standing.
function diffSnapshots(before, after, top) {
  const allIds = new Set([...Object.keys(before.shows || {}), ...Object.keys(after.shows || {})]);
  const rows = [];
  for (const id of allIds) {
    const b = before.shows[id];
    const a = after.shows[id];
    const beforeScore = b ? b.displayScore : 0;
    const afterScore = a ? a.displayScore : 0;
    const delta = afterScore - beforeScore;
    if (delta === 0) continue;
    rows.push({
      showId: id,
      title: (a && a.title) || (b && b.title) || id,
      before: beforeScore,
      after: afterScore,
      delta,
      badge: (a && a.badge) || (b && b.badge) || null,
      presentBefore: !!b,
      presentAfter: !!a,
    });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { totalCompared: allIds.size, movedCount: rows.length, movers: rows.slice(0, top) };
}

// CLI contract — preserves scripts/award-score-movers.js's existing exact
// week-start matching + error messages. Returns { error } instead of
// throwing/exiting so the CLI stays in charge of process.exit codes.
function resolveMoversForWeek({ historyDir, weekStart, end, market, top }) {
  const dates = listAvailableDates(historyDir, market);
  if (dates.length === 0) {
    return { error: `no snapshots found in ${historyDir} for market=${market}` };
  }
  const before = loadSnapshot(historyDir, weekStart, market);
  if (!before) {
    return { error: `no snapshot for week-start ${weekStart} (have: ${dates.join(', ')})` };
  }
  let afterDate = end;
  if (!afterDate) {
    const after = dates.filter((d) => d > weekStart);
    if (after.length === 0) {
      // Only one snapshot exists — empty deltas, not an error (cron shouldn't alarm).
      return {
        weekStart,
        weekEnd: weekStart,
        market,
        movers: [],
        note: 'only one snapshot available; no comparison possible',
      };
    }
    afterDate = after[after.length - 1];
  }
  const after = loadSnapshot(historyDir, afterDate, market);
  if (!after) {
    return { error: `no snapshot for end date ${afterDate}` };
  }
  const { totalCompared, movedCount, movers } = diffSnapshots(before, after, top);
  return { weekStart, weekEnd: afterDate, market, totalCompared, movedCount, movers };
}

// Newsletter contract — diffs the two most recent available snapshots.
// Returns null when fewer than 2 snapshots exist yet (nothing to compare;
// the newsletter section should render nothing, not an empty section).
function latestMovers({ historyDir, market = 'broadway', top = 5 }) {
  const dates = listAvailableDates(historyDir, market);
  if (dates.length < 2) return null;
  const weekStart = dates[dates.length - 2];
  const weekEnd = dates[dates.length - 1];
  const before = loadSnapshot(historyDir, weekStart, market);
  const after = loadSnapshot(historyDir, weekEnd, market);
  if (!before || !after) return null;
  const { totalCompared, movedCount, movers } = diffSnapshots(before, after, top);
  return { weekStart, weekEnd, market, totalCompared, movedCount, movers };
}

module.exports = {
  snapshotFilename,
  listAvailableDates,
  loadSnapshot,
  diffSnapshots,
  resolveMoversForWeek,
  latestMovers,
};
