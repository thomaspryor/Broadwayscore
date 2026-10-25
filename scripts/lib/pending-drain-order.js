'use strict';
/**
 * Order _pending work newest-first for replay-pending-bylines.js (BRO-4408).
 *
 * The opening-night poller drains _pending with a 4-minute budget. Files with
 * no detectable byline stay in _pending and are re-fetched every run, so in
 * readdir order the same ~40 old strands (venue pages, tag pages) ate the
 * whole budget on every poll (2026-10-12 runs: "Promoted: 0, Kept: 41", budget
 * hit each time) and a fresh opening-night review queued behind them.
 *
 * Newest first: the show holding the most recent strand goes first, and
 * within a show the most recent file goes first. "Recent" is the later of
 * firstSeenAt and publishDate; a file with neither sorts last.
 */

function pendingFileTimestamp(data) {
  let best = 0;
  for (const v of [data && data.firstSeenAt, data && data.publishDate]) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/**
 * @param {Array<{showId:string, files:Array<{file:string, ts:number}>}>} shows
 * @returns {Array<{showId:string, files:string[]}>}
 */
function orderPendingWork(shows) {
  const byTsDesc = (a, b) => b.ts - a.ts || a.file.localeCompare(b.file);
  return shows
    .map((s, i) => {
      const files = [...s.files].sort(byTsDesc);
      return { showId: s.showId, files, newest: files.length ? files[0].ts : 0, i };
    })
    .sort((a, b) => b.newest - a.newest || a.i - b.i)
    .map(s => ({ showId: s.showId, files: s.files.map(f => f.file) }));
}

module.exports = { pendingFileTimestamp, orderPendingWork };
