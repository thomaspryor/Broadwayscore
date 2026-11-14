'use strict';

/**
 * Field-level shows.json reconciliation used by push-core-data/action.yml
 * after a push-conflict rebase (`git pull --rebase -X ours`), which makes
 * OUR side win outright on any show both sides touched. This recovers a
 * safelist of "manually correctable" fields that -X ours may have dropped
 * because remote added them while we were running.
 *
 * Bug this fixes (task #1817): the original inline version restored a
 * RECONCILABLE field from remote whenever OUR value was null/undefined,
 * with no way to tell "we never had this value" apart from "we just
 * deliberately cleared it." fix-shared-ibdb-urls.js nulls a revival's
 * stale, shared ibdbUrl as a self-heal — but remote's copy (origin/main,
 * which had never received a prior run's fix either) still had the old
 * shared URL, so the old logic treated that as "remote added a value we
 * lost" and restored the exact bug the self-heal had just cleared, on
 * every push retry. Confirmed live: runs from 2026-07-03 through
 * 2026-08-19 healed the working tree every time but never once landed the
 * fix in a commit (checked via `gh api .../commits` diffs — ibdbUrl never
 * appears touched by any "Update from update-show-status" commit).
 *
 * Fix: only restore a field from remote when the PRE-RUN baseline
 * (/tmp/core-data-snapshot's shows.json, i.e. what this job started from)
 * was ALSO null/undefined for it, OR remote's current value has genuinely
 * changed since baseline. If baseline had a value, our current local
 * doesn't, AND remote's value is still that same baseline value, this run
 * intentionally cleared it — never let that stale, unchanged remote value
 * override a deliberate clear. But if remote's value differs from
 * baseline, a concurrent writer legitimately changed it after our
 * baseline snapshot, and that new value should still be recovered
 * (second-opinion review finding, task #1817 follow-up).
 */

const RECONCILABLE_FIELDS = [
  'venue', 'synopsis', 'runtime', 'intermissions', 'ageRecommendation',
  'officialUrl', 'wikipediaUrl', 'ibdbUrl',
  'openingDate', 'previewsStartDate', 'openingDateSource',
  'humanCorrectedClosingDate', 'humanCorrectedOpeningDate',
  'tourLegs', 'priorRuns',
];

// Object-valued fields merged per sub-key in the 3-way pass, so two writers
// touching DIFFERENT formats of the same object both survive (BRO-5011: a
// plan nulling images.thumbnail must not lose a concurrent images.hero).
const NESTED_3WAY_FIELDS = ['images'];

function isEmpty(v) {
  return v === null || v === undefined;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural equality for JSON values (shows.json rows). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Standard 3-way merge of one object's keys onto `target` (mutated):
 * when ours still equals base and theirs changed it, a concurrent writer
 * made the change and -X ours dropped it, so theirs wins (a key theirs
 * deleted is deleted). When ours changed it, ours wins.
 * @returns {number} keys taken from theirs
 */
/** Copy (or drop) the synopsisSource that belongs to a synopsis just taken from theirs. */
function moveSynopsisStamp(target, theirs) {
  if (Object.prototype.hasOwnProperty.call(theirs, 'synopsisSource')) target.synopsisSource = theirs.synopsisSource;
  else delete target.synopsisSource;
}

function threeWayKeys(target, theirs, base, nested = []) {
  let taken = 0;
  const keys = new Set([...Object.keys(base), ...Object.keys(target), ...Object.keys(theirs)]);
  for (const k of keys) {
    if (k === 'id') continue;
    // BRO-4856: the provenance stamp travels with its synopsis, never on its own.
    if (k === 'synopsisSource') continue;
    const has = (o) => Object.prototype.hasOwnProperty.call(o, k);
    const oursVal = target[k];
    const theirsVal = theirs[k];
    const baseVal = base[k];
    const oursSame = has(target) === has(base) && deepEqual(oursVal, baseVal);
    const theirsSame = has(theirs) === has(base) && deepEqual(theirsVal, baseVal);
    if (theirsSame) continue; // remote did not touch it — ours stands
    if (oursSame) {
      if (has(theirs)) target[k] = theirsVal; else delete target[k];
      if (k === 'synopsis') moveSynopsisStamp(target, theirs);
      taken++;
      continue;
    }
    // Both sides changed it. For nested objects, merge per sub-key.
    if (nested.includes(k) && isPlainObject(oursVal) && isPlainObject(theirsVal)
        && (isPlainObject(baseVal) || baseVal === undefined || baseVal === null)) {
      taken += threeWayKeys(oursVal, theirsVal, isPlainObject(baseVal) ? baseVal : {});
    }
    // Otherwise a true conflict: ours wins (-X ours semantics).
  }
  return taken;
}

/**
 * Reconcile one show in place on `localShow`:
 *  1. 3-way pass (BRO-5011), only when the baseline row exists: every
 *     top-level field this run left at its baseline value takes remote's
 *     value if remote changed it; `images` merges per format.
 *  2. RECONCILABLE_FIELDS pass: refill an empty local field from remote,
 *     unless baseline had that same value (a deliberate clear, #1817).
 * @returns {number} count of fields recovered from remote
 */
function reconcileShowFields(localShow, remoteShow, baseShow, fields = RECONCILABLE_FIELDS) {
  let recovered = 0;
  if (isPlainObject(baseShow)) {
    recovered += threeWayKeys(localShow, remoteShow, baseShow, NESTED_3WAY_FIELDS);
  }
  for (const key of fields) {
    const remoteVal = remoteShow[key];
    if (isEmpty(remoteVal)) continue;
    if (!isEmpty(localShow[key])) continue; // we already have a value — keep ours

    // deepEqual, not ===: array fields (tourLegs, priorRuns) are never ===
    // across separately parsed files, so a deliberate clear was resurrected.
    if (baseShow && !isEmpty(baseShow[key]) && deepEqual(baseShow[key], remoteVal)) {
      // Baseline (pre-run) had this exact value, our local doesn't anymore
      // (this run deliberately cleared it), and remote still has the SAME
      // stale value — do not let it back in. If remote's value differs from
      // baseline, a concurrent writer legitimately changed it after our
      // baseline snapshot was taken, and that genuinely-new value should
      // still be recovered.
      continue;
    }

    localShow[key] = remoteVal;
    if (key === 'synopsis') moveSynopsisStamp(localShow, remoteShow);
    recovered++;
  }
  return recovered;
}

/**
 * Normalize the caller's retired-id input to a Set. Require an explicit
 * list so reconciliation stays pure without silently disabling retirement
 * protection when a caller forgets to load its registry.
 */
function toRetiredSet(retiredIds) {
  if (retiredIds instanceof Set) return retiredIds;
  if (Array.isArray(retiredIds)) return new Set(retiredIds);
  throw new TypeError('reconcileShowsJson: retiredIds must be a Set or an array');
}

/**
 * Reconcile a full shows.json against remote's copy, mutating `local` in
 * place: recovers dropped fields per reconcileShowFields, and re-adds whole
 * shows remote added while this job ran (never re-adds a show the base
 * snapshot also lacked-and-local-deleted — that's an intentional delete).
 *
 * 2026 data audit (S0-T4): a RETIRED id (data/retired-show-ids.json) is
 * never re-added, even when the base snapshot lacks it. The base check
 * alone cannot protect a deletion made in ANOTHER run: once the deleting
 * run has pushed, every later job's base snapshot lacks the id too, so a
 * stale concurrent writer that still carried the row on its remote side
 * would read as a "genuine concurrent add" and resurrect it (the phantom
 * "?tab=dates" row came back this way).
 *
 * @param {{shows: Array}} local - our post-rebase shows.json (mutated)
 * @param {{shows: Array}} remote - origin's shows.json before our rebase
 * @param {{shows: Array}|null} base - the pre-run baseline snapshot, or
 *   null when unavailable (shallow clone with no merge-base, etc.)
 * @param {string[]} [fields] - RECONCILABLE_FIELDS override (tests)
 * @param {Set<string>|string[]} retiredIds - required, caller-loaded retired
 *   ids; pass an empty Set or array when the caller has no registry
 * @returns {{recovered: number, readded: number, baseAvailable: boolean,
 *   retiredSkipped: number}} retiredSkipped counts remote-only shows that
 *   were NOT re-added because their id is retired
 */
function reconcileShowsJson(local, remote, base, fields = RECONCILABLE_FIELDS, retiredIds) {
  const retired = toRetiredSet(retiredIds);
  const localShows = local.shows || (local.shows = []);
  const localMap = new Map();
  for (const s of localShows) if (s && s.id) localMap.set(s.id, s);

  const baseAvailable = !!base;
  const baseMap = new Map();
  if (base) for (const s of base.shows || []) if (s && s.id) baseMap.set(s.id, s);

  let recovered = 0;
  let readded = 0;
  let retiredSkipped = 0;

  for (const rs of remote.shows || []) {
    if (!rs || !rs.id) continue;
    const ls = localMap.get(rs.id);
    if (!ls) {
      // Show missing locally and retired: never re-add, whatever the base
      // says (S0-T4). Counted separately so the action can log it.
      if (retired.has(rs.id)) {
        retiredSkipped++;
        continue;
      }
      // Show missing locally: only re-add if the baseline ALSO lacked it
      // (a genuine concurrent add). If baseline had it, our missing copy is
      // a deliberate delete this run made — honor it.
      if (baseAvailable && !baseMap.has(rs.id)) {
        localShows.push(rs);
        localMap.set(rs.id, rs);
        readded++;
      }
      continue;
    }
    recovered += reconcileShowFields(ls, rs, baseMap.get(rs.id), fields);
  }

  return { recovered, readded, baseAvailable, retiredSkipped };
}

module.exports = { RECONCILABLE_FIELDS, NESTED_3WAY_FIELDS, deepEqual, reconcileShowFields, reconcileShowsJson };
