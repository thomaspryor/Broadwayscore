// Per-slug JSON merge for commercial.json and commercial-pending-review.json.
//
// Why this exists:
//   scripts/lib/push-with-retry.sh and .github/actions/push-core-data/action.yml
//   previously reconciled shows.json + audience-buzz.json but treated every
//   other data file as "accept remote" — silently dropping local additions on
//   push retry. With the Friday scraper + (future) RSS poller + closing-stale
//   classifier all writing to these two files in different workflows, that
//   silent-drop behaviour was a data-loss bug waiting to happen.
//   Ship-check called it CDX-P0-1 / CDX-P0-2.
//
// Used by:
//   - scripts/lib/push-with-retry.sh (resolve_conflicts case for these files)
//   - .github/actions/push-core-data/action.yml (post-rebase reconcile)
//   - tests/unit/merge-commercial-data.test.mjs
//
// Merge rules — commercial.json:
//   * shape: { shows: { [slug]: entry, ... }, _meta: {...} }
//   * For each slug present in either side: pick the entry whose `lastUpdated`
//     is newer. If the older side carries `humanReviewedDesignation === true`
//     OR `humanReviewedWrongProduction === true`, overlay those fields onto
//     the chosen entry — those are manual corrections that must survive any
//     CI rewrite.
//   * A slug on only one side: kept (local or remote addition), unless a
//     true common ancestor `base` shows it was DELETED (BRO-4657). Live
//     2026-10-05: Commercial Friday Refresh deleted two id-keyed duplicates,
//     its push was rejected, and the post-rebase union re-added both from
//     remote. With base: a one-sided slug that is in base and unchanged from
//     base was deleted by the other side, so it is dropped (both directions,
//     stats.resolvedAsDeletion). One that changed since base is kept (a
//     delete racing an edit keeps the edit). Without base: union, as before.
//   * A slug on both sides that is also in base: merged FIELD BY FIELD
//     (BRO-4657). A field only one side changed takes that side's value; a
//     field both changed differently takes the pickNewer winner's; fields
//     validate-data checks against each other (LINKED_FIELD_GROUPS) move
//     as one unit so the result is always one side's combination. Live
//     2026-10-05: an approved fix rewrote Lucky Guy's designation without
//     touching lastUpdated, Commercial Friday's stale copy (which had only
//     refreshed model bookkeeping) tied on lastUpdated, won whole-record,
//     and silently reverted the fix. Without base: whole-record pickNewer.
//   * `base` must be the real fork point, never a post-rebase merge-base
//     (that equals remote and would read every remote addition as our
//     delete), hence `requiresTrueBase` for reconcile-merged-json.js.
//
// Merge rules — commercial-pending-review.json:
//   * shape: { shows: { [slug]: pendingEntry, ... }, lastUpdated, ... }
//   * For each slug: pick the entry whose `researchedAt` (or `detectedAt` as
//     fallback) is newer. Manual-protection fields are not applicable here —
//     pending entries are throwaway claims awaiting apply.
//   * Union of slugs is kept.
//
// Merge rules — commercial-research-queue.json:
//   * shape: { shows: [slug, ...], triggers: { [slug]: reason }, updatedAt }
//   * Written by 5 different cron workflows (commercial-weekly, commercial-
//     friday, update-commercial, scrape-waltz-costs, update-show-status) —
//     previously NOT in this file's exemption list, so it fell to the
//     generic "accept remote" case in push-with-retry.sh and silently
//     dropped local queue additions on conflict.
//   * `shows` is a deduped union of both sides' arrays (order: ours first,
//     then remote-only additions appended).
//   * `triggers` is a shallow merge; on key collision, keep whichever side's
//     entry belongs to the union decision for that slug (both sides usually
//     agree on the reason for the same slug — this is a rare edge case).
//   * `updatedAt` becomes the newer of the two timestamps.

const { syncBreakevenToCost } = require('./commercial-breakeven');

const HUMAN_REVIEWED_COMMERCIAL_FIELDS = [
  'humanReviewedDesignation',
  'humanReviewedRecouped',
  'humanReviewedCapitalization',
];

function entryDate(entry, fields) {
  for (const f of fields) {
    const v = entry?.[f];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

function pickNewer(ours, remote, dateFields) {
  const oursT = entryDate(ours, dateFields);
  const remoteT = entryDate(remote, dateFields);
  return remoteT > oursT ? remote : ours;
}

function overlayHumanReviewed(target, candidate) {
  // If candidate has any humanReviewed* flag set true, copy those flags + the
  // adjacent values they protect. Manual review wins regardless of timestamps.
  let touched = false;
  for (const f of HUMAN_REVIEWED_COMMERCIAL_FIELDS) {
    if (candidate?.[f] === true && target[f] !== true) {
      target[f] = true;
      touched = true;
    }
  }
  return touched;
}

// True when `entry` is the base copy untouched, i.e. the side holding it did
// not edit it and the side lacking it deleted it.
function unchangedSinceBase(baseShows, slug, entry) {
  if (!baseShows || !Object.prototype.hasOwnProperty.call(baseShows, slug)) return false;
  return JSON.stringify(baseShows[slug]) === JSON.stringify(entry);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Fields validate-data checks against each other (designation vs recouped,
// recouped vs recoupedDate, "Tour Stop" vs productionType; the classifier's
// stamps describe the designation). Taking some from each side could build a
// record neither side wrote, e.g. one side's Fizzle with the other's
// recouped:true, so each group merges as one unit.
//
// Every field merge-model-recoupment.js writes is one run's output (BRO-4989
// Step 0): a record never mixes two runs. A run only READS the cost fields,
// so a run on a stale copy and a cost fix on the other side change different
// units and both survive; syncBreakevenToCost below then rescales the run's
// break-even to the merged cost, as the write guard does on every save.
// The run's other outputs (recoupment %, modelRecouped) catch up at the next
// run. tests/unit/merge-commercial-data.test.mjs checks this list against
// every model field merge-model-recoupment.js assigns.
const MODEL_RUN_FIELDS = [
  'modelRecoupmentPct', 'modelRecouped', 'modelBreakeven', 'modelCostBasis', 'modelDataQuality',
  'modelMethod', 'modelCategory', 'modelLastRun', 'modelWarnings', 'modelDesignationFlag',
  // BRO-4989 shadow fields (written alongside, never read by the site yet).
  'modelRecoupmentPctV2', 'modelInvestorMultiple',
];
const LINKED_FIELD_GROUPS = [
  ['designation', 'productionType', 'recouped', 'recoupedDate', 'recoupedSource', 'classifiedBy', 'classifiedAt', 'classifiedReason'],
  ['capitalization', 'capitalizationSource'],
  ['weeklyRunningCost', 'costMethodology', 'weeklyRunningCostSource', 'weeklyRunningCostNote', 'weeklyRunningCostRange'],
  MODEL_RUN_FIELDS,
];
const GROUP_OF = new Map(LINKED_FIELD_GROUPS.flatMap(g => g.map(f => [f, g])));
// Bookkeeping both sides bump on any write, and model output both sides
// recomputed: a differing value is not a content conflict worth reporting.
const isContentUnit = (unit) => unit !== MODEL_RUN_FIELDS && !(unit.length === 1 && unit[0] === 'lastUpdated');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Three-way merge of one record both sides kept, field by field (linked
// fields as one unit). A unit only one side changed since base takes that
// side's values; a unit both changed differently takes `winner`'s (the
// pickNewer choice). isEstimate holds one flag per field
// ({ weeklyRunningCost: true, recouped: true }) and merges per flag; a flag
// both sides changed follows the side its field came from, so a cost never
// carries the other writer's flag.
// Returns the merged record, the number of conflicting units, and the
// conflicting units that hold content (not just bookkeeping).
function mergeRecordFields(o, r, b, winner) {
  const out = {};
  let conflicts = 0;
  const contentConflicts = [];
  let modelRunConflict = false;
  const sourceOf = new Map();
  const singletons = new Map();
  const unitOf = (k) => GROUP_OF.get(k) || singletons.get(k) || singletons.set(k, [k]).get(k);
  const pick = (unit) => {
    if (sourceOf.has(unit)) return sourceOf.get(unit);
    const same = (x, y) => unit.every(f => sameValue(x[f], y[f]));
    let src;
    if (same(o, b)) src = r;
    else if (same(r, b) || same(o, r)) src = o;
    else {
      conflicts++;
      if (isContentUnit(unit)) contentConflicts.push(unit[0]);
      else if (unit === MODEL_RUN_FIELDS) modelRunConflict = true;
      src = winner;
    }
    sourceOf.set(unit, src);
    return src;
  };
  const splitEstimate = [o, r, b].some(x => isPlainObject(x.isEstimate))
    && [o, r, b].every(x => x.isEstimate === undefined || isPlainObject(x.isEstimate));
  const keys = new Set([...Object.keys(o), ...Object.keys(r), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'isEstimate' && splitEstimate) continue;
    const v = pick(unitOf(k))[k];
    if (v !== undefined) out[k] = v;
  }
  if (splitEstimate) {
    const est = {};
    const flags = new Set([o, r, b].flatMap(x => Object.keys(x.isEstimate || {})));
    const flagOf = (x, f) => (x.isEstimate || {})[f];
    for (const f of flags) {
      // Three-way per flag; only a flag both sides changed differently
      // follows the side its field came from.
      let src;
      if (sameValue(flagOf(o, f), flagOf(b, f))) src = r;
      else if (sameValue(flagOf(r, f), flagOf(b, f)) || sameValue(flagOf(o, f), flagOf(r, f))) src = o;
      else src = pick(unitOf(f));
      const v = flagOf(src, f);
      if (v !== undefined) est[f] = v;
    }
    if (Object.keys(est).length) out.isEstimate = est;
  }
  return { record: out, conflicts, contentConflicts, modelRunConflict };
}

// Three parameters with no default: callers dispatch on `.length >= 3`.
function mergeCommercialJson(ours, remote, base) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const baseShows = base && typeof base.shows === 'object' && base.shows ? base.shows : null;
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0, kept = 0, overlaid = 0, resolvedAsDeletion = 0, fieldMerged = 0, fieldConflicts = 0, breakevenResynced = 0, modelRunConflicts = 0;
  const conflictSlugs = [];
  const allSlugs = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const slug of allSlugs) {
    const o = oursShows[slug];
    const r = remoteShows[slug];
    if (!o && r) {
      if (unchangedSinceBase(baseShows, slug, r)) { resolvedAsDeletion++; continue; }
      merged.shows[slug] = r; added++; continue;
    }
    if (o && !r) {
      if (unchangedSinceBase(baseShows, slug, o)) { delete merged.shows[slug]; resolvedAsDeletion++; continue; }
      kept++; continue;
    }
    if (!o && !r) continue;
    // Both sides have the slug. Pick newer by lastUpdated, then overlay any
    // humanReviewed* flags from the loser so manual corrections survive.
    // With a base copy of the record, merge field by field instead, so a
    // side that only touched bookkeeping fields cannot wipe the other side's
    // correction (BRO-4657).
    const winner = pickNewer(o, r, ['lastUpdated', 'firstAdded']);
    const loser = winner === o ? r : o;
    const b = baseShows && baseShows[slug];
    let chosen;
    if (b && typeof b === 'object' && !sameValue(o, r)) {
      const res = mergeRecordFields(o, r, b, winner);
      chosen = res.record;
      fieldMerged++;
      fieldConflicts += res.conflicts;
      if (res.modelRunConflict) modelRunConflicts++; // both re-ran the model; the newer run kept whole
      if (res.contentConflicts.length) conflictSlugs.push(`${slug} (${res.contentConflicts.join(', ')})`);
      // The run's break-even and the merged cost can come from different
      // sides; rescale it exactly as the write guard does on save (BRO-4985).
      if (syncBreakevenToCost(chosen)) breakevenResynced++;
    } else {
      chosen = { ...winner };
    }
    if (overlayHumanReviewed(chosen, loser)) overlaid++;
    merged.shows[slug] = chosen;
  }

  // _meta: pick newer lastUpdated
  if (remote._meta?.lastUpdated || ours._meta?.lastUpdated) {
    const newer = pickNewer(remote._meta || {}, ours._meta || {}, ['lastUpdated']);
    merged._meta = { ...(ours._meta || {}), ...(remote._meta || {}), ...newer };
  }

  return { merged, stats: { added, kept, overlaid, resolvedAsDeletion, fieldMerged, fieldConflicts, breakevenResynced, modelRunConflicts, conflictSlugs, totalSlugs: allSlugs.size } };
}
// reconcile-merged-json.js: without PUSH_RECONCILE_BASE, pass no base (union)
// rather than the post-rebase merge-base, which equals remote.
mergeCommercialJson.requiresTrueBase = true;

const PENDING_ENTRY_DATE_FIELDS = ['researchedAt', 'detectedAt', 'lastUpdated'];

function mergePendingReview(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0;
  let resolvedAsDeletion = 0;
  const allSlugs = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const slug of allSlugs) {
    const o = oursShows[slug];
    const r = remoteShows[slug];
    if (!o && r) { merged.shows[slug] = r; added++; continue; }
    if (o && !r) {
      // 10 scripts write/delete individual keys in this file (apply-
      // commercial-pending.js removes applied shows, sweep-pending-
      // commercial.js removes expired ones) on independent cron schedules —
      // "remote lacks a slug ours still has" is ambiguous between "remote's
      // base predates ours' addition" (keep ours, current behavior) and
      // "remote already applied/swept it" (must NOT resurrect — same class
      // of bug as mergeResearchQueue, ship-check finding 2026-07-19,
      // /what-else follow-up). Use ours' entry timestamp vs remote's
      // file-level lastUpdated as a logical clock: if remote's last write
      // happened AFTER this entry existed, remote has definitely seen (and
      // removed) it.
      // Strict '<', not '<=' (ship-check finding, 2026-07-19): equal
      // timestamps don't prove remote saw this entry — could be an
      // unrelated write stamped in the same millisecond. On a tie, default
      // to keeping ours; only delete when remote is UNAMBIGUOUSLY newer.
      const entryTime = entryDate(o, PENDING_ENTRY_DATE_FIELDS);
      const remoteFileTime = entryDate(remote, ['lastUpdated']);
      if (remote.lastUpdated && entryTime > 0 && entryTime < remoteFileTime) {
        delete merged.shows[slug];
        resolvedAsDeletion++;
      }
      continue;
    }
    merged.shows[slug] = pickNewer(o, r, PENDING_ENTRY_DATE_FIELDS);
  }

  // Refresh top-level lastUpdated to whichever side is newer
  const newer = pickNewer(remote, ours, ['lastUpdated']);
  if (newer?.lastUpdated) merged.lastUpdated = newer.lastUpdated;

  return { merged, stats: { added, resolvedAsDeletion, totalSlugs: allSlugs.size } };
}

function mergeResearchQueue(ours, remote) {
  ours = ours || { shows: [], triggers: {} };
  remote = remote || { shows: [], triggers: {} };
  const oursShows = Array.isArray(ours.shows) ? ours.shows : [];
  const remoteShows = Array.isArray(remote.shows) ? remote.shows : [];

  // deep-research-commercial.js consumes the queue by writing {shows: [],
  // updatedAt} after processing. A plain array-union would resurrect those
  // already-researched slugs if a concurrent producer's stale add lands in
  // the same conflict (ship-check finding, 2026-07-19) — reprocessing them
  // forever on every future conflict. Whichever side is BOTH empty and
  // strictly newer is a consumption event and wins outright; only fall
  // through to the additive union when neither side looks like a clear.
  if (oursShows.length === 0 && pickNewer(remote, ours, ['updatedAt']) === ours) {
    return { merged: { ...ours, shows: [], triggers: ours.triggers || {} }, stats: { added: 0, totalShows: 0, resolvedAsConsumption: 'ours' } };
  }
  if (remoteShows.length === 0 && pickNewer(ours, remote, ['updatedAt']) === remote) {
    return { merged: { ...remote, shows: [], triggers: remote.triggers || {} }, stats: { added: 0, totalShows: 0, resolvedAsConsumption: 'remote' } };
  }

  const seen = new Set(oursShows);
  const mergedShows = [...oursShows];
  let added = 0;
  for (const slug of remoteShows) {
    if (!seen.has(slug)) {
      mergedShows.push(slug);
      seen.add(slug);
      added++;
    }
  }

  const merged = { ...ours };
  merged.shows = mergedShows;
  merged.triggers = { ...(remote.triggers || {}), ...(ours.triggers || {}) };

  const newer = pickNewer(remote, ours, ['updatedAt']);
  if (newer?.updatedAt) merged.updatedAt = newer.updatedAt;

  return { merged, stats: { added, totalShows: mergedShows.length } };
}

module.exports = {
  HUMAN_REVIEWED_COMMERCIAL_FIELDS,
  LINKED_FIELD_GROUPS,
  MODEL_RUN_FIELDS,
  mergeCommercialJson,
  mergePendingReview,
  mergeResearchQueue,
};
