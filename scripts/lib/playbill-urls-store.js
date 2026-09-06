'use strict';

/**
 * playbill-urls-store.js — read/modify/write data/playbill-urls.json without
 * losing a concurrent writer's entries.
 *
 * THE BUG (BRO-2895). All THREE writers of that cache did a whole-file
 * read-modify-write with no coordination. BRO-2895 and BRO-2893 both say "both
 * writers"; the third was found by grepping for the write rather than trusting
 * the cards, and it is the one reached from five workflows:
 *   scripts/discover-playbill-urls.js     — fs.writeFileSync(OUTPUT_PATH, ...)
 *   scripts/fetch-show-images-auto.js     — fs.writeFileSync(PLAYBILL_URLS_PATH, ...)
 *   scripts/enrich-off-broadway-dates.js  — fs.writeFileSync(PLAYBILL_URL_CACHE_PATH, ...)
 * If you add a fourth, route it through here; a direct write silently reopens
 * every case below.
 * Two runs each read the file, each add their own shows, and the second write
 * discards the first's. Nothing throws and nothing is logged, so the only
 * symptom is a show that "never got a Playbill URL" and gets re-resolved at SERP
 * cost next run. All three writers are cron-driven and this machine routinely
 * runs several sessions at once.
 *
 * WHAT THIS CLOSES AND WHAT IT DOES NOT. Read this before trusting it; an
 * earlier draft of this comment claimed the race was closed and that was FALSE.
 *
 * CLOSED: the large window. A writer used to hold a whole-file copy for the
 * length of its run — minutes, and for fetch-show-images-auto.js across many
 * network round trips — and write it back wholesale. Every entry a peer added in
 * that window died. Now only this process's DELTA is replayed, onto a read taken
 * immediately before the write, so a peer's entries survive.
 *
 * NOT CLOSED: the read-to-rename window inside save(). A and B can both re-read
 * {base}, A build {base,a}, B build {base,b}, A rename, B rename — and A's entry
 * is gone, even though only A set it. Atomic rename prevents a TORN file; it does
 * not serialise read-modify-write. Closing this needs a lock around the
 * read-merge-write (scripts/lib/file-lock.js) or a CAS-retry loop on the file's
 * mtime/inode, and it needs EVERY writer to take it.
 *
 * NOT CLOSED: a stale SET clobbering a correction. Sets are unconditional, so if
 * A resolves X, B then verifies and corrects the key to Y, and A finally saves,
 * A restores X. "Last save" is not "freshest resolution". Deletes are already
 * compare-and-swap for exactly this reason; sets need the same treatment plus a
 * conflict policy, which is a behavioural decision this change did not make.
 *
 * The residual is strictly smaller than what was there before, and the tests
 * below are in-process and SERIALISED, so they prove the delta logic and cannot
 * prove the multi-process behaviour. See BRO-2910 for the remaining work.
 *
 * WHY tmp+rename ALONE WOULD HAVE BEEN A FALSE FIX, in the card's own words:
 * it cures the TORN read and leaves the LOST UPDATE, which is the silent half.
 * The atomic write here is real (atomicWriteJson) but it is the smaller part.
 *
 * WHAT THE NAIVE MERGE GETS WRONG, enumerated, because "union the two objects"
 * is the obvious version and it is wrong in both directions:
 *   - `{...mine, ...onDisk}` loses every entry I just resolved. The whole point.
 *   - `{...onDisk, ...mine}` RESURRECTS entries another writer deliberately
 *     DELETED, because my in-memory copy still holds the pre-delete value. No
 *     caller deletes today — validate-show-venue.js's cross-market self-heal
 *     IGNORES a bad cached URL and re-resolves, it does not remove or re-save it
 *     — so this guards a deletion path someone adds later, not one in the tree
 *     now. It is here because the naive merge would make adding that path
 *     silently ineffective; the tests pin the behaviour either way.
 * So the unit of replay is MY DELTA — the keys that differ between the snapshot
 * I loaded and the object I am saving — applied onto a FRESH read of the file.
 * Keys I never touched are whatever disk says, including gone.
 */

const fs = require('fs');
const { atomicWriteJson } = require('./atomic-shows-write');

const EMPTY = () => ({ shows: {}, lastUpdated: null });

/** Read the cache, returning both the working copy and an immutable snapshot. */
/**
 * ONLY A MISSING FILE RESETS TO EMPTY. Everything else THROWS.
 *
 * The first draft caught every error and returned {} — so an unparseable file, a
 * permission error, or a half-written file from a non-atomic writer all read as
 * "no entries", and the next save then wrote this run's handful of entries over
 * the top with allowShrink:true silently disabling the size guard. A transient
 * corruption became an authorised wipe of the whole cache. ENOENT is the only
 * genuinely recoverable case (first run); the rest are conditions a human should
 * see, because a cache this expensive to rebuild must not be silently discarded.
 */
class PlaybillUrlsCacheError extends Error {
  constructor(filePath, cause) {
    super(`Refusing to read ${filePath} as an empty cache: ${cause}. `
      + 'Fix or delete the file deliberately — an empty read here authorises '
      + 'overwriting every cached URL with only this run\'s entries.');
    this.name = 'PlaybillUrlsCacheError';
  }
}

function loadPlaybillUrls(filePath) {
  let parsed;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new PlaybillUrlsCacheError(filePath, err.message);
    return { data: EMPTY(), snapshot: {} };
  }
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PlaybillUrlsCacheError(filePath, `not valid JSON (${err.message})`);
  }
  // `typeof [] === 'object'`, so an ARRAY passes a bare typeof check and then
  // behaves as an empty map through Object.entries — a wrong-shaped file would
  // read as "no entries" and the first save would overwrite it with the caller's
  // few. Array.isArray is the guard that catches it, and it THROWS rather than
  // resetting: a wrong shape is a condition a human should see, not one to write
  // over. An earlier draft DID reset here, and its own test caught the array hole.
  const shows = parsed && parsed.shows;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !shows || typeof shows !== 'object' || Array.isArray(shows)) {
    throw new PlaybillUrlsCacheError(filePath, 'shape is not { shows: { id: url } }');
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
 * SETS are unconditional and DELETES are compare-and-swap. The asymmetry is
 * deliberate but it is NOT free, and the header records the cost: an
 * unconditional set can restore a stale url over a peer's verified correction,
 * because "last save" is not "freshest resolution". It is left unconditional
 * here only because choosing otherwise is a behavioural decision (older loses /
 * older wins / log the conflict) that belongs to BRO-2910, not to this change.
 * Do not read this paragraph as saying either answer is equally good. A
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
  // and it is NOT limited to keys both processes set — two disjoint writers can
  // still lose one entry there. See the header; closing it needs a lock.
  const { data: onDisk } = loadPlaybillUrls(filePath);
  const ours = (current && current.shows) || {};
  let recovered = 0;
  for (const id of Object.keys(onDisk.shows)) {
    if (!Object.prototype.hasOwnProperty.call(ours, id)) recovered += 1;
  }
  const merged = applyDelta(onDisk, delta);
  merged.lastUpdated = new Date().toISOString();
  // allowShrink: a delete replayed from a caller's delta removes entries, and
  // this file is small enough that one removal can exceed the 5% line-count
  // floor the shrink guard applies to shows.json. Note the floor is not load-
  // bearing here anyway now that a corrupt read throws instead of returning an
  // empty cache — that reset was the path by which a shrink guard would have
  // been the last thing standing between a bad read and a wiped file.
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
      // Re-baseline to what THIS process holds, not to what is on disk. Peer
      // entries merged in during save() are deliberately NOT copied into `data`
      // — they are absent from both the new baseline and `data`, so the next
      // computeDelta sees them in neither and will not mistake them for
      // deletions. What this line prevents is the next save replaying THIS
      // save's sets again over a value a peer has since corrected.
      baseline = { ...data.shows };
      return result;
    },
  };
}

module.exports = {
  PlaybillUrlsCacheError,
  loadPlaybillUrls,
  savePlaybillUrls,
  openPlaybillUrls,
  computeDelta,
  applyDelta,
};
