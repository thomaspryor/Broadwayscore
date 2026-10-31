/**
 * BRO-5901: dedup must never pick a survivor that a later gate then drops.
 *
 * rebuild-all-reviews.js walks a show's files in priority order and lets the
 * first copy of a review win (seenKeys / URL / fingerprint maps, syndication
 * primaries). Before this module, the winner's claim was recorded BEFORE the
 * gates that run after it (tour/film contamination, skippedNoScore), and the
 * syndication rule asked only "does a primary FILE exist and look unflagged?".
 * When the winner then died at a later gate, the loser had already been
 * skipped and nothing re-promoted it: both copies vanished (paranormal-
 * activity-2026, 2026-08-26: an unscored chicagotribune--chris-jones.json
 * re-ingest shielded the scored nydailynews copy, then hit skippedNoScore).
 *
 * The static rule (review-guards.js hasIncludableSyndicationPrimary, used by
 * explainExclusion, the scorer and audits) can disagree with the rebuild here:
 * it cannot know that a primary will die at a dedup or contamination gate.
 * The rebuild's answer, from what it actually emitted, is the one that ships.
 *
 * Two pure pieces, both wired into the rebuild's per-show loop:
 *  - createClaimLedger(): dedup claims a file makes are undone unless that file
 *    is actually emitted, so the next copy in priority order can survive.
 *  - orderAfterDependencies() + syndicationShieldDecision(): every syndicated
 *    secondary (and unknown-outlet shadow) is processed after the files it
 *    defers to, so it is skipped only when one of them really survived.
 */
const { getSyndicationPrimaries, isPrimaryFileFor } = require('./syndication-pairs');

/**
 * Per-file transactional claims on the dedup maps/sets. begin() at the top of
 * each file; arm() once the file has passed every dedup check; commit() when
 * it is emitted; rollback() from a try/finally. Only an ARMED, uncommitted
 * file is rolled back: a file dropped BY dedup itself (a URL or fingerprint
 * loser) keeps its earlier claims exactly as before, so only the gates after
 * dedup (contamination, skippedNoScore, or an error thrown after arm())
 * re-open the slot. Claims taken before arm() by a file that later loses a
 * dedup check or throws stay held, as they always did.
 * rollback() returns null for a file that was not armed (or was committed),
 * else the number of claims undone; a non-null result means "this file won
 * dedup and then died", which the rebuild records as released.
 * Writes that register claims for an already-emitted file (the twin URL
 * carry) must not go through the ledger.
 */
function createClaimLedger() {
  let undo = [];
  let armed = false;
  return {
    begin() { undo = []; armed = false; },
    arm() { armed = true; },
    /** map.set(key, value), restoring the previous value (or absence) on rollback. */
    setClaim(map, key, value) {
      const had = map.has(key);
      const prev = map.get(key);
      map.set(key, value);
      undo.push(() => { if (had) map.set(key, prev); else map.delete(key); });
    },
    /** set.add(key), removed on rollback only if this file added it. */
    addClaim(set, key) {
      if (set.has(key)) return;
      set.add(key);
      undo.push(() => set.delete(key));
    },
    commit() { undo = []; armed = false; },
    /** Undo an armed file's claims, newest first. Returns how many were undone. */
    rollback() {
      if (!armed) { undo = []; return null; }
      armed = false;
      const n = undo.length;
      for (let i = n - 1; i >= 0; i--) undo[i]();
      undo = [];
      return n;
    },
  };
}

/**
 * Primary filenames in `files` that `file` (a syndicated secondary) defers to.
 * @param {string} file
 * @param {{criticName?:string, outletKey?:string}|undefined} meta outletKey already canonicalized by the caller
 * @param {string[]} files
 */
function primaryFilesFor(file, meta, files) {
  if (!meta || !meta.criticName || !meta.outletKey) return [];
  const critic = String(meta.criticName).toLowerCase().trim();
  const primaries = getSyndicationPrimaries(critic, meta.outletKey);
  if (!primaries.length) return [];
  return files.filter(f => f !== file && isPrimaryFileFor(f, primaries, critic));
}

/**
 * Named-outlet files an unknown-outlet shadow copy defers to
 * (unknown--samuel-l-leiter.json defers to theater-life--samuel-l-leiter.json).
 * Filename-based, matching the rebuild's own unknown-outlet dedup.
 * @param {string} file
 * @param {string[]} files
 */
function unknownOutletShadowTargets(file, files) {
  const m = /^(?:unknown|unnamed)--(.+)\.json$/.exec(file);
  if (!m || /^(?:unknown|unnamed)$/.test(m[1])) return [];
  const suffix = `--${m[1]}.json`;
  return files.filter(f => f !== file && f.endsWith(suffix) && !/^(?:unknown|unnamed)--/.test(f));
}

/**
 * Stable reorder: each file that defers to others (a syndicated secondary to
 * its primaries, an unknown-outlet shadow to the named-outlet copy) moves to
 * just after the last file it defers to, when it currently sorts before one.
 * The dedup priority sort puts scored files first, so a scored secondary can
 * otherwise be processed before an unscored primary whose fate decides it.
 * Everything else keeps its priority order. Chains (baltimoresun defers to
 * nydailynews, which defers to chicagotribune) settle in a few passes; the
 * loop is bounded, so a cycle cannot hang it.
 * @param {string[]} files priority-sorted filenames
 * @param {(file:string, files:string[])=>string[]} depsOf files `file` must follow
 * @returns {string[]} new array
 */
function orderAfterDependencies(files, depsOf) {
  const out = files.slice();
  const deps = new Map();
  for (const f of out) {
    const p = depsOf(f, out);
    if (p.length) deps.set(f, p);
  }
  if (!deps.size) return out;
  for (let pass = 0; pass <= deps.size; pass++) {
    let moved = false;
    for (const [sec, prims] of deps) {
      const si = out.indexOf(sec);
      const lastPrim = Math.max(...prims.map(p => out.indexOf(p)));
      if (lastPrim > si) {
        out.splice(si, 1);
        out.splice(lastPrim, 0, sec); // lastPrim shifted down by one after the removal
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/**
 * Should a syndicated secondary be skipped in favour of its primary files?
 * Once every primary file has been processed, the answer follows their real
 * fate, the same split as shadowShieldDecision below:
 *  - a primary was emitted: skip (the review ships under the primary);
 *  - every primary won dedup and then died at a later gate (released): keep
 *    the secondary, nothing else carries the review (BRO-5901);
 *  - some primary was dropped before dedup finished: it either lost dedup to
 *    another copy of the same review (still shield, or the critic counts
 *    twice) or was dropped for its own flags. The static on-disk predicate
 *    over just those files tells the two apart.
 * If a primary has not been processed yet (it should not happen after
 * orderAfterDependencies) fall back to the static predicate over all of them.
 * @param {{primaryFiles:string[], processed:Set<string>, emitted:Set<string>, released:Set<string>, fallback:(files:string[])=>boolean}} args
 * @returns {{skip:boolean, basis:'emitted'|'none-emitted'|'dropped-before-dedup'|'no-primary'|'fallback'}}
 */
function syndicationShieldDecision({ primaryFiles, processed, emitted, released, fallback }) {
  if (!primaryFiles.length) return { skip: false, basis: 'no-primary' };
  if (primaryFiles.some(f => emitted.has(f))) return { skip: true, basis: 'emitted' };
  if (primaryFiles.every(f => processed.has(f))) {
    const dropped = primaryFiles.filter(f => !released.has(f));
    if (!dropped.length) return { skip: false, basis: 'none-emitted' };
    return { skip: !!fallback(dropped), basis: 'dropped-before-dedup' };
  }
  return { skip: !!fallback(primaryFiles), basis: 'fallback' };
}

/**
 * Unknown-outlet shadow rule. A named-outlet copy keeps shielding the shadow
 * when it was dropped BEFORE dedup finished (duplicateOf, wrong production:
 * the shadow is the same review and should go too) or has not been processed.
 * It stops shielding only when it won dedup and then died at a later gate
 * (released), because then nothing else will carry the review.
 * @param {{targets:string[], released:Set<string>}} args
 * @returns {boolean} true = skip the shadow
 */
function shadowShieldDecision({ targets, released }) {
  return targets.some(t => !released.has(t));
}

module.exports = {
  createClaimLedger, primaryFilesFor, unknownOutletShadowTargets, orderAfterDependencies, syndicationShieldDecision, shadowShieldDecision,
};
