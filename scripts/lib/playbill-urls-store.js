'use strict';

/**
 * playbill-urls-store.js — read/modify/write data/playbill-urls.json without
 * losing a concurrent writer's entries.
 *
 * THE BUG (BRO-2895). Both writers of that cache did a whole-file
 * read-modify-write with no coordination:
 *   scripts/discover-playbill-urls.js  — fs.writeFileSync(OUTPUT_PATH, ...)
 *   scripts/fetch-show-images-auto.js  — fs.writeFileSync(PLAYBILL_URLS_PATH, ...)
 * Two runs each read the file, each add their own shows, and the second write
 * discards the first's. Nothing throws and nothing is logged, so the only
 * symptom is a show that "never got a Playbill URL" and gets re-resolved at SERP
 * cost next run. Both writers are cron-driven and this machine routinely runs
 * several sessions at once.
 *
 * WHY MERGE-ON-WRITE AND NOT A LOCK. The card left that open. A lock
 * (scripts/lib/file-lock.js exists and is exercised 20x in CI) would serialise
 * the two writers, but it only protects writers that TAKE it: a third writer, a
 * hand edit, or a future script that forgets, and the loss is silently back.
 * Merge-on-write is a property of the write itself, so it holds no matter who
 * else is writing or whether they cooperate. It is also cheaper — no lock file,
 * no stale-lock recovery path, no new failure mode.
 *
 * WHY tmp+rename ALONE WOULD HAVE BEEN A FALSE FIX, in the card's own words:
 * it cures the TORN read and leaves the LOST UPDATE, which is the silent half.
 * The atomic write here is real (atomicWriteJson) but it is the smaller part.
 *
 * WHAT THE NAIVE MERGE GETS WRONG, enumerated, because "union the two objects"
 * is the obvious version and it is wrong in both directions:
 *   - `{...mine, ...onDisk}` loses every entry I just resolved. The whole point.
 *   - `{...onDisk, ...mine}` RESURRECTS entries another writer deliberately
 *     DELETED, because my in-memory copy still holds the pre-delete value. The
 *     read-side self-heal in validate-show-venue.js evicts cross-market cache
 *     entries on purpose; this would put them straight back.
 * So the unit of replay is MY DELTA — the keys that differ between the snapshot
 * I loaded and the object I am saving — applied onto a FRESH read of the file.
 * Keys I never touched are whatever disk says, including gone.
 */

const fs = require('fs');
const { atomicWriteJson } = require('./atomic-shows-write');

const EMPTY = () => ({ shows: {}, lastUpdated: null });

/** Read the cache, returning both the working copy and an immutable snapshot. */
function loadPlaybillUrls(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    parsed = EMPTY();
  }
  // `typeof [] === 'object'`, so an ARRAY passes a bare typeof check and then
  // behaves as an empty map through Object.entries — a wrong-shaped file would
  // read as "no entries" and the first save would overwrite it with the caller's
  // few. Array.isArray is the guard that turns that into a reset, and the test
  // for it caught this exact hole in the first draft of this function.
  const shows = parsed && parsed.shows;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !shows || typeof shows !== 'object' || Array.isArray(shows)) {
    parsed = EMPTY();
  }
  return { data: parsed, snapshot: { ...parsed.shows } };
}

/**
 * What did THIS process change?
 * @returns {{sets: Record<string,string>, deletes: Record<string,string>}}
 *   `deletes` maps id -> the value it had at snapshot time, so the delete can be
 *   replayed conditionally (see applyDelta).
 */
function computeDelta(snapshot, current) {
  const sets = {};
  const deletes = {};
  const before = snapshot || {};
  const after = (current && current.shows) || {};
  for (const [id, url] of Object.entries(after)) {
    if (before[id] !== url) sets[id] = url;
  }
  for (const [id, url] of Object.entries(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, id)) deletes[id] = url;
  }
  return { sets, deletes };
}

/**
 * Replay a delta onto whatever is on disk now.
 *
 * SETS are unconditional and DELETES are compare-and-swap, and the asymmetry is
 * deliberate. A set is a fresh resolution: if a peer resolved the same show in
 * the same window, either answer is current and last-write-wins is honest. A
 * delete is an eviction decided against a value I read possibly minutes ago — if
 * a peer has since written a DIFFERENT url for that id, my delete is stale and
 * would destroy a fresher answer. So a delete only lands when disk still holds
 * exactly the value the delete was decided against.
 */
function applyDelta(onDisk, delta) {
  const shows = { ...((onDisk && onDisk.shows) || {}) };
  for (const [id, url] of Object.entries(delta.deletes)) {
    if (shows[id] === url) delete shows[id];
  }
  for (const [id, url] of Object.entries(delta.sets)) {
    shows[id] = url;
  }
  return { ...(onDisk || EMPTY()), shows };
}

/**
 * Merge this process's changes into the file and write atomically.
 *
 * @param {string} filePath
 * @param {object} current   the working copy returned by loadPlaybillUrls().data
 * @param {object} snapshot  the snapshot returned by loadPlaybillUrls().snapshot
 * @returns {{written: boolean, sets: number, deletes: number, recovered: number}}
 *   `recovered` counts entries that existed on disk but not in this process's
 *   working copy — i.e. entries a concurrent writer added since our read, which
 *   the old whole-file write would have destroyed. It is the number this fix
 *   exists to make non-zero, so callers can log it.
 */
function savePlaybillUrls(filePath, current, snapshot) {
  const delta = computeDelta(snapshot, current);
  // Re-read as late as possible: everything a peer wrote up to this instant is
  // preserved. The residual window is between this read and the rename below,
  // in which only a key BOTH processes set can be lost — and there one value
  // has to win regardless.
  const { data: onDisk } = loadPlaybillUrls(filePath);
  const ours = (current && current.shows) || {};
  let recovered = 0;
  for (const id of Object.keys(onDisk.shows)) {
    if (!Object.prototype.hasOwnProperty.call(ours, id)) recovered += 1;
  }
  const merged = applyDelta(onDisk, delta);
  merged.lastUpdated = new Date().toISOString();
  // allowShrink: a legitimate eviction (the cross-market self-heal) removes
  // entries, and this file is small enough that one removal can exceed the 5%
  // line-count floor the shrink guard applies to shows.json.
  atomicWriteJson(filePath, merged, { allowShrink: true });
  return {
    written: true,
    sets: Object.keys(delta.sets).length,
    deletes: Object.keys(delta.deletes).length,
    recovered,
  };
}

/**
 * A load/save SESSION, which is what a caller that saves more than once needs.
 *
 * WHY THIS EXISTS RATHER THAN LEAVING IT TO THE CALLER. fetch-show-images-auto.js
 * saves after EVERY resolved show, so the snapshot has to be re-baselined after
 * each save — otherwise the second save replays the first save's sets again, and
 * would re-assert a value a peer corrected in between. That re-baselining was
 * three lines of state inline in a 1,400-line CLI, reachable only through an
 * image-source fallback that a normal run does not enter, so nothing tested it
 * and running the script did not exercise it. Here it is covered.
 */
function openPlaybillUrls(filePath) {
  const { data, snapshot } = loadPlaybillUrls(filePath);
  let baseline = snapshot;
  return {
    data,
    /** @returns {{written:boolean, sets:number, deletes:number, recovered:number}} */
    save() {
      const result = savePlaybillUrls(filePath, data, baseline);
      // Everything just written IS the on-disk state now, so the next save's
      // delta covers only what changes from here.
      baseline = { ...data.shows };
      return result;
    },
  };
}

module.exports = {
  loadPlaybillUrls,
  savePlaybillUrls,
  openPlaybillUrls,
  computeDelta,
  applyDelta,
};
