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
  'humanCorrectedClosingDate',
  'tourLegs', 'priorRuns',
];

function isEmpty(v) {
  return v === null || v === undefined;
}

/**
 * Reconcile one show's RECONCILABLE fields in place on `localShow`.
 * @returns {number} count of fields recovered from remote
 */
function reconcileShowFields(localShow, remoteShow, baseShow, fields = RECONCILABLE_FIELDS) {
  let recovered = 0;
  for (const key of fields) {
    const remoteVal = remoteShow[key];
    if (isEmpty(remoteVal)) continue;
    if (!isEmpty(localShow[key])) continue; // we already have a value — keep ours

    if (baseShow && !isEmpty(baseShow[key]) && baseShow[key] === remoteVal) {
      // Baseline (pre-run) had this exact value, our local doesn't anymore
      // (this run deliberately cleared it), and remote still has the SAME
      // stale value — do not let it back in. If remote's value differs from
      // baseline, a concurrent writer legitimately changed it after our
      // baseline snapshot was taken, and that genuinely-new value should
      // still be recovered.
      continue;
    }

    localShow[key] = remoteVal;
    recovered++;
  }
  return recovered;
}

/**
 * Reconcile a full shows.json against remote's copy, mutating `local` in
 * place: recovers dropped fields per reconcileShowFields, and re-adds whole
 * shows remote added while this job ran (never re-adds a show the base
 * snapshot also lacked-and-local-deleted — that's an intentional delete).
 *
 * @param {{shows: Array}} local - our post-rebase shows.json (mutated)
 * @param {{shows: Array}} remote - origin's shows.json before our rebase
 * @param {{shows: Array}|null} base - the pre-run baseline snapshot, or
 *   null when unavailable (shallow clone with no merge-base, etc.)
 * @returns {{recovered: number, readded: number, baseAvailable: boolean}}
 */
function reconcileShowsJson(local, remote, base, fields = RECONCILABLE_FIELDS) {
  const localShows = local.shows || (local.shows = []);
  const localMap = new Map();
  for (const s of localShows) if (s && s.id) localMap.set(s.id, s);

  const baseAvailable = !!base;
  const baseMap = new Map();
  if (base) for (const s of base.shows || []) if (s && s.id) baseMap.set(s.id, s);

  let recovered = 0;
  let readded = 0;

  for (const rs of remote.shows || []) {
    if (!rs || !rs.id) continue;
    const ls = localMap.get(rs.id);
    if (!ls) {
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

  return { recovered, readded, baseAvailable };
}

module.exports = { RECONCILABLE_FIELDS, reconcileShowFields, reconcileShowsJson };
