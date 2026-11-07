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
 * CLOSED (BRO-2910): the read-to-rename window inside save(). A and B used to
 * be able to both re-read {base}, A build {base,a}, B build {base,b}, A rename,
 * B rename, and A's entry was gone even though only A set it. Atomic rename
 * prevents a TORN file; it does not serialise read-modify-write. save() now
 * holds scripts/lib/file-lock.js (`<file>.lock`) around the re-read, merge and
 * rename, and every writer goes through save(), so every writer takes it. The
 * multi-process test spawns real child processes racing on one temp file.
 * file-lock fails OPEN after its timeout (a leftover lock must not wedge a
 * cron), so a stuck holder degrades to the old merge-on-write behaviour, not
 * to a blocked writer.
 *
 * CLOSED (BRO-2910): a stale SET clobbering a correction. Sets used to be
 * unconditional, so if A resolved X, B then corrected the key to Y, and A
 * finally saved, A restored X. Sets are now compare-and-swap like deletes: a
 * set lands only when disk still holds the value this process's baseline had
 * for that id (or nothing). Otherwise a peer wrote that id AFTER our baseline,
 * so its answer is the fresher one and ours is dropped and reported in
 * `conflicts`. Policy chosen: the older resolution loses, loudly.
 *
 * GUARDED (BRO-2893): every new set is judged by playbill-cache-guard.js (the
 * BRO-2821 title matcher plus the market rejects) before it is persisted, so a
 * wrong attribution can no longer be written once and returned forever.
 * Refused sets are reverted in the caller's working copy and reported in
 * `refused`.
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
const path = require('path');
const { atomicWriteJson } = require('./atomic-shows-write');
const { withFileLock } = require('./file-lock');
const { buildPlaybillCacheGuard } = require('./playbill-cache-guard');
const { findConflictingKey } = require('./cache-collision');

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
 * @returns {{sets: Record<string,string>, deletes: Record<string,string>, was: Record<string,string>}}
 *   `deletes` and `was` map id -> the value it had at snapshot time, so both
 *   deletes and sets can be replayed conditionally (see applyDelta).
 */
function computeDelta(snapshot, current) {
  const sets = {};
  const deletes = {};
  const was = {};
  const before = snapshot || {};
  const after = (current && current.shows) || {};
  for (const [id, url] of Object.entries(after)) {
    if (before[id] !== url) {
      sets[id] = url;
      if (before[id] !== undefined) was[id] = before[id];
    }
  }
  for (const [id, url] of Object.entries(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, id)) deletes[id] = url;
  }
  return { sets, deletes, was };
}

/**
 * Replay a delta onto whatever is on disk now.
 *
 * Both SETS and DELETES are compare-and-swap against the value this process's
 * baseline held for the id (BRO-2910). A delete is an eviction decided against
 * a value read possibly minutes ago; a set is a resolution made against the
 * same stale view. If a peer has since written a DIFFERENT value for that id,
 * the peer's write is newer than our baseline, so ours is the stale one and is
 * dropped rather than destroying a fresher answer ("last save" is not
 * "freshest resolution"). A set onto an id disk no longer has (a peer evicted
 * it) still lands: an eviction is not a competing answer.
 *
 * Cross-show collisions (BRO-4060): a set whose URL another show id already
 * owns on disk is refused and reported in `collisions`. A Playbill production
 * page is one production, so two ids sharing it means one of them is a wrong
 * attribution (a same-title revival matched onto the original's page, or a
 * hand-removed mapping re-resolved back). Checked here, against the fresh
 * read taken under the lock, so a peer's claim made after our load counts too.
 * A refused REPLACEMENT keeps the id's previous disk value when no other id
 * claims it (an explicit delete in the same delta is already applied above,
 * so an evicted URL stays evicted).
 *
 * @returns {{data: object, conflicts: Array<{id: string, mine: string, disk: string}>,
 *   collisions: Array<{id: string, url: string, owner: string}>}}
 */
function applyDelta(onDisk, delta) {
  const shows = { ...((onDisk && onDisk.shows) || {}) };
  const conflicts = [];
  const collisions = [];
  for (const [id, url] of Object.entries(delta.deletes)) {
    if (shows[id] === url) delete shows[id];
  }
  const was = delta.was || {};
  const accepted = [];
  for (const [id, url] of Object.entries(delta.sets)) {
    const disk = shows[id];
    if (disk === undefined || disk === url || disk === was[id]) {
      accepted.push([id, url, disk]);
    } else {
      conflicts.push({ id, mine: url, disk });
    }
  }
  // Release every accepted id's old value BEFORE checking any of them, so a
  // swap or move between two ids inside one save is judged on the end state,
  // not on iteration order.
  for (const [id] of accepted) delete shows[id];
  const refusedPrev = [];
  for (const [id, url, disk] of accepted) {
    const owner = findConflictingKey(shows, id, url);
    if (owner === null) {
      shows[id] = url;
      continue;
    }
    collisions.push({ id, url, owner, unchanged: disk === url });
    // Disk already held exactly this url: a no-op set never removes an
    // existing entry (a pre-existing collision is an audit's job, not ours).
    if (disk === url) shows[id] = disk;
    else if (disk !== undefined) refusedPrev.push([id, disk]);
  }
  // Put a refused id's previous value back once every accepted set has
  // claimed its url, unless another id now owns it.
  for (const [id, disk] of refusedPrev) {
    if (findConflictingKey(shows, id, disk) === null) shows[id] = disk;
  }
  return { data: { ...(onDisk || EMPTY()), shows }, conflicts, collisions };
}

/**
 * The default write guard: the corpus next to the cache file. Read per save
 * (a save is rare and the corpus changes under long runs). An unreadable
 * corpus refuses every set, never loosens to "accept anything".
 */
const guardCache = new Map(); // showsPath -> {mtimeMs, size, guard}
function defaultGuardFor(filePath, showsPath) {
  const p = showsPath || path.join(path.dirname(filePath), 'shows.json');
  let st = null;
  try { st = fs.statSync(p); } catch { /* missing corpus */ }
  // Per-process cache keyed on mtime+size: writers that save once per show
  // would otherwise re-parse the multi-MB corpus on every save.
  const hit = st && guardCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.guard;
  let shows = [];
  try {
    shows = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* empty corpus: every set is refused as unknown-show */ }
  const guard = buildPlaybillCacheGuard(shows);
  if (st) guardCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, guard });
  return guard;
}

/**
 * Merge this process's changes into the file and write atomically, under the
 * cache's file lock.
 *
 * @param {string} filePath
 * @param {object} current   the working copy returned by loadPlaybillUrls().data
 * @param {object} snapshot  the snapshot returned by loadPlaybillUrls().snapshot
 * @param {{guard?: (id: string, url: string) => {ok: boolean, reason: ?string},
 *          lockOpts?: object, showsPath?: string}} [opts]
 *   guard defaults to playbill-cache-guard.js over `showsPath`, else the
 *   shows.json next to the cache. Tests of the merge logic pass their own.
 * @returns {{written: boolean, sets: number, deletes: number, recovered: number,
 *   refused: Array<{id,url,reason}>, conflicts: Array<{id,mine,disk}>}}
 *   `recovered` counts entries a concurrent writer added since our read, which
 *   the old whole-file write destroyed. `refused` are sets the guard rejected;
 *   `conflicts` are sets dropped because a peer wrote that id after our
 *   baseline. Callers log all three.
 */
function savePlaybillUrls(filePath, current, snapshot, opts = {}) {
  const delta = computeDelta(snapshot, current);
  const guard = opts.guard || defaultGuardFor(filePath, opts.showsPath);
  const refused = [];
  for (const [id, url] of Object.entries(delta.sets)) {
    const v = guard(id, url);
    if (v && v.ok) continue;
    refused.push({ id, url, reason: (v && v.reason) || 'refused' });
    delete delta.sets[id];
    // Drop the refused value from the caller's working copy too, so a later
    // save in the same session does not see it as already persisted. A refused
    // REPLACEMENT becomes a delete of the old value, never a restore of it: the
    // caller replaced it because it judged it wrong (enrich-off-broadway-dates
    // evicts a dead URL, then sets the fresh one), and restoring it would pin
    // the dead URL forever and re-search it every run (ship-check finding).
    const prev = (snapshot || {})[id];
    delete current.shows[id];
    if (prev !== undefined) delta.deletes[id] = prev;
  }
  return withFileLock(`${filePath}.lock`, () => {
    // Re-read UNDER THE LOCK: everything a peer wrote up to this instant is
    // preserved, and no peer can write between this read and the rename below.
    const { data: onDisk } = loadPlaybillUrls(filePath);
    const ours = (current && current.shows) || {};
    let recovered = 0;
    for (const id of Object.keys(onDisk.shows)) {
      if (!Object.prototype.hasOwnProperty.call(ours, id)) recovered += 1;
    }
    const { data: merged, conflicts, collisions } = applyDelta(onDisk, delta);
    // Adopt the peer's fresher value in the working copy, so the caller's
    // in-memory view matches what was persisted.
    for (const c of conflicts) current.shows[c.id] = c.disk;
    // A collision-refused set is reverted in the working copy to whatever was
    // persisted for that id (usually nothing), and reported with the refusals.
    for (const c of collisions) {
      if (Object.prototype.hasOwnProperty.call(merged.shows, c.id)) current.shows[c.id] = merged.shows[c.id];
      else delete current.shows[c.id];
      // disk already held this exact url for this id: nothing was refused.
      if (!c.unchanged) refused.push({ id: c.id, url: c.url, reason: `cross-show-collision: already cached for ${c.owner}` });
    }
    merged.lastUpdated = new Date().toISOString();
    // allowShrink: a delete replayed from a caller's delta removes entries, and
    // this file is small enough that one removal can exceed the 5% line-count
    // floor the shrink guard applies to shows.json. A corrupt read throws
    // above instead of returning an empty cache, so this cannot authorise a wipe.
    atomicWriteJson(filePath, merged, { allowShrink: true });
    return {
      written: true,
      sets: Object.keys(delta.sets).length - conflicts.length - collisions.length,
      deletes: Object.keys(delta.deletes).length,
      recovered,
      refused,
      conflicts,
    };
  }, opts.lockOpts);
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
function openPlaybillUrls(filePath, opts = {}) {
  const { data, snapshot } = loadPlaybillUrls(filePath);
  let baseline = snapshot;
  return {
    data,
    /** @returns {ReturnType<typeof savePlaybillUrls>} */
    save() {
      const result = savePlaybillUrls(filePath, data, baseline, opts);
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

/**
 * One shared way for every writer to report a save, so a refused or conflicted
 * write is never silent in one writer and loud in another.
 */
function logSaveResult(r, log = console.log) {
  if (!r) return;
  if (r.recovered > 0) log(`  [playbill-urls] merged ${r.recovered} entry(ies) another writer added since load`);
  for (const x of r.refused || []) log(`  [playbill-urls] REFUSED ${x.id} -> ${x.url} (${x.reason}); not cached`);
  for (const c of r.conflicts || []) log(`  [playbill-urls] kept peer's newer ${c.id} -> ${c.disk}; dropped this run's stale ${c.mine}`);
}

module.exports = {
  logSaveResult,
  PlaybillUrlsCacheError,
  loadPlaybillUrls,
  savePlaybillUrls,
  openPlaybillUrls,
  computeDelta,
  applyDelta,
};
