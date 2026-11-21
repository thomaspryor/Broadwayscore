'use strict';
/**
 * Order _pending work for replay-pending-bylines.js (BRO-4408, BRO-7930).
 *
 * Two modes:
 *  - 'newest' (default; opening-night poller, --show/--shows): newest first, so a fresh
 *    opening-night review is never queued behind old no-byline strands (BRO-4408: the same
 *    ~40 old strands ate the 4-minute budget every poll).
 *  - 'rotate' (--all-open / --all-pending sweeps): a stable path order resumed AFTER a
 *    persisted cursor, so a budget-limited run always starts where the last one stopped and
 *    every file is reached in a bounded number of runs. BRO-7930: the weekly all-pending run
 *    used its 16 minutes on ~58 files, newest-first every week, so 2,446 files without
 *    firstSeenAt/publishDate sorted last and were never reached.
 *
 * "Recent" is the later of firstSeenAt and publishDate; a file with neither falls back to its
 * file mtime (BRO-7930) instead of 0.
 */

function pendingFileTimestamp(data, mtimeMs) {
  let best = 0;
  for (const v of [data && data.firstSeenAt, data && data.publishDate]) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > best) best = t;
  }
  // Day-quantized: a same-day write burst (checkout, one collector run) must tie, not reorder by milliseconds.
  if (best === 0 && Number.isFinite(mtimeMs) && mtimeMs > 0) best = Math.floor(mtimeMs / 864e5) * 864e5;
  return best;
}

/** Stable total order key for a pending file: "showId/file". */
const pathKey = (showId, file) => `${showId}/${file}`;

/**
 * @param {Array<{showId:string, files:Array<{file:string, ts:number}>}>} shows
 * @param {{mode?:'newest'|'rotate', cursor?:string|null}} [opts]
 * @returns {Array<{showId:string, files:string[]}>}
 */
function orderPendingWork(shows, opts = {}) {
  if (opts.mode === 'rotate') return rotateFromCursor(shows, opts.cursor || null);
  const byTsDesc = (a, b) => b.ts - a.ts || a.file.localeCompare(b.file);
  return shows
    .map((s, i) => {
      const files = [...s.files].sort(byTsDesc);
      return { showId: s.showId, files, newest: files.length ? files[0].ts : 0, i };
    })
    .sort((a, b) => b.newest - a.newest || a.i - b.i)
    .map(s => ({ showId: s.showId, files: s.files.map(f => f.file) }));
}

/** Flatten to path order, start strictly after `cursor` (wrapping), regroup by show in that order. */
function rotateFromCursor(shows, cursor) {
  const flat = [];
  for (const s of shows) for (const f of s.files) flat.push(pathKey(s.showId, f.file));
  flat.sort();
  let start = 0;
  if (cursor) {
    const i = flat.findIndex(k => k > cursor);
    start = i === -1 ? 0 : i; // cursor past the end (or its file was drained): wrap to the top
  }
  const rotated = flat.slice(start).concat(flat.slice(0, start));
  const out = [];
  for (const k of rotated) {
    const slash = k.indexOf('/');
    const showId = k.slice(0, slash), file = k.slice(slash + 1);
    const last = out[out.length - 1];
    if (last && last.showId === showId) last.files.push(file);
    else out.push({ showId, files: [file] });
  }
  return out;
}

module.exports = { pendingFileTimestamp, orderPendingWork, rotateFromCursor, pathKey };
