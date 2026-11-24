'use strict';
/**
 * BRO-8214 (BRO-8056 plan v14-final §1.5 steps 3-6, row 11): which shows the
 * show-refresh publisher carries, as one pure decision.
 *
 * Inputs:
 *   manifest  - the live build manifest (show-refresh/manifest.js)
 *   head      - the shows computed from HEAD data at the build's clock:
 *               { registrySha, sliceVersion, shows: { id: { hash, held, slug, imagesSig, reviewCount, reviewsSig, error? } } }
 *   prevHome  - the published index (home row) or null
 *   flagged   - ids the staleness guard flagged (Set or array)
 *   rebuildStep - true when run as the rebuild workflow's step (the review list
 *               may change: the rebuild just scored it)
 *
 * No fs, no network, no clock: `now` comes in.
 */
const { isUsableManifest } = require('./manifest');

const OUTCOMES = Object.freeze({
  PUBLISH: 'publish',
  NOTHING_TO_DO: 'nothing-to-do',
  MANIFEST_UNUSABLE: 'manifest-unusable',
  SLICE_VERSION: 'slice-version',
  REGISTRY_MISMATCH: 'registry-mismatch',
  CAP: 'cap',
  // Set by the CLI, never by planPublish:
  KILLED: 'killed',
  CAS_LOST: 'cas-lost',
});

const SKIPS = Object.freeze({
  HELD_BUILD: 'held-build',
  NOT_IN_HEAD: 'not-in-head',
  COMPUTE_ERROR: 'compute-error',
  HELD_HEAD: 'held-head',
  UNCHANGED: 'unchanged',
  IMAGES_CHANGED: 'images-changed',
  // The reader serves a slice only at the build's URL (show-refresh-core.ts
  // rejects a slug mismatch), so a renamed show waits for the deploy.
  SLUG_CHANGED: 'slug-changed',
  FLAGGED: 'flagged',
  NO_REVIEW_META: 'no-review-meta',
  REVIEW_COUNT_DROP: 'review-count-drop',
  REVIEW_LIST_CHANGED: 'review-list-changed',
  // Not a rebuild step, the review list moved, and home already carries this
  // show from a rebuild step: keep that published entry (never revert it to the
  // build just because a backstop run cannot vouch for the review list).
  REVIEW_LIST_KEPT: 'review-list-kept',
});

const DEFAULT_CAP = 40;
const EXPECT_BASE = 'base';

/** Why a manifest show is not carried, or null when it is a target. */
function skipReason(id, built, cur, { flagged, rebuildStep, prev }) {
  if (built.held) return SKIPS.HELD_BUILD;
  if (!cur) return SKIPS.NOT_IN_HEAD;
  if (cur.error || typeof cur.hash !== 'string') return SKIPS.COMPUTE_ERROR;
  if (cur.held) return SKIPS.HELD_HEAD;
  if (cur.hash === built.hash) return SKIPS.UNCHANGED;
  if (cur.imagesSig !== built.imagesSig) return SKIPS.IMAGES_CHANGED;
  if (typeof built.slug === 'string' && cur.slug !== built.slug) return SKIPS.SLUG_CHANGED;
  if (flagged.has(id)) return SKIPS.FLAGGED;
  if (!Number.isFinite(built.reviewCount) || typeof built.reviewsSig !== 'string'
    || !Number.isFinite(cur.reviewCount) || typeof cur.reviewsSig !== 'string') return SKIPS.NO_REVIEW_META;
  if (cur.reviewCount < built.reviewCount) return SKIPS.REVIEW_COUNT_DROP;
  if (cur.reviewsSig !== built.reviewsSig && !rebuildStep) {
    // A rebuild step already published exactly this slice: carrying it is no new claim.
    if (prev && prev.hash === cur.hash) return null;
    return prev ? SKIPS.REVIEW_LIST_KEPT : SKIPS.REVIEW_LIST_CHANGED;
  }
  return null;
}

/**
 * @returns {{outcome: string, targets: Array<{id: string, hash: string}>, skips: Record<string, string>,
 *   dirty: string[], nextHome: {manifestId: string, shows: Record<string, {hash: string}>, pending: object} | null,
 *   counts: object}}
 */
function planPublish({ manifest, head, prevHome = null, flagged = [], rebuildStep = false, cap = DEFAULT_CAP, now }) {
  if (!Number.isFinite(now)) throw new Error('planPublish: now (ms epoch) is required');
  const empty = (outcome) => ({ outcome, targets: [], skips: {}, dirty: [], nextHome: null, counts: { targets: 0 } });
  if (!isUsableManifest(manifest)) return empty(OUTCOMES.MANIFEST_UNUSABLE);
  if (!head || head.sliceVersion !== manifest.sliceVersion) return empty(OUTCOMES.SLICE_VERSION);

  const flaggedSet = flagged instanceof Set ? flagged : new Set(flagged || []);
  const headShows = head.shows || {};
  // A home written for another build is moot (row 4): start over.
  const samePrev = !!prevHome && prevHome.manifestId === manifest.manifestId;
  const prevShows = (samePrev && prevHome.shows) || {};
  const pending = { ...((samePrev && prevHome.pending) || {}) };

  const skips = {};
  const eligible = [];
  const kept = [];
  for (const id of Object.keys(manifest.shows).sort()) {
    const prev = Object.hasOwn(prevShows, id) ? prevShows[id] : null;
    const why = skipReason(id, manifest.shows[id], Object.hasOwn(headShows, id) ? headShows[id] : null, { flagged: flaggedSet, rebuildStep, prev });
    if (why === SKIPS.REVIEW_LIST_KEPT) kept.push({ id, hash: prev.hash });
    if (why) skips[id] = why; else eligible.push({ id, hash: headShows[id].hash });
  }
  const dirty = Object.keys(headShows).filter((id) => !Object.hasOwn(manifest.shows, id)).sort();

  let outcome = null;
  if (head.registrySha !== manifest.registrySha) outcome = OUTCOMES.REGISTRY_MISMATCH;
  else if (eligible.length > cap) outcome = OUTCOMES.CAP;

  const shows = {};
  const changed = [];
  let targets = [];
  if (outcome) {
    // Carry nothing new: keep only what is published and still HEAD.
    for (const [id, e] of Object.entries(prevShows)) {
      const cur = Object.hasOwn(headShows, id) ? headShows[id] : null;
      if (cur && !cur.error && cur.hash === e.hash) shows[id] = { hash: e.hash };
    }
  } else {
    targets = eligible;
    for (const k of kept) shows[k.id] = { hash: k.hash };
    for (const t of targets) {
      shows[t.id] = { hash: t.hash };
      if (!prevShows[t.id] || prevShows[t.id].hash !== t.hash) {
        changed.push(t.id);
        pending[t.id] = { since: now, expect: t.hash };
      }
    }
  }
  // Row 11: a published id that left the index (reverted, removed, now skipped)
  // still renders its old slice until revalidated back to the build.
  const removed = Object.keys(prevShows).filter((id) => !Object.hasOwn(shows, id)).sort();
  for (const id of removed) pending[id] = { since: now, expect: EXPECT_BASE };

  if (!outcome) outcome = changed.length || removed.length ? OUTCOMES.PUBLISH : OUTCOMES.NOTHING_TO_DO;

  const skipCounts = {};
  for (const why of Object.values(skips)) skipCounts[why] = (skipCounts[why] || 0) + 1;
  return {
    outcome,
    targets,
    skips,
    dirty,
    nextHome: { manifestId: manifest.manifestId, shows, pending },
    counts: {
      manifestShows: Object.keys(manifest.shows).length,
      headShows: Object.keys(headShows).length,
      eligible: eligible.length,
      targets: targets.length,
      changed: changed.length,
      removed: removed.length,
      kept: kept.length,
      dirty: dirty.length,
      pending: Object.keys(pending).length,
      skips: skipCounts,
    },
  };
}

module.exports = { planPublish, OUTCOMES, SKIPS, DEFAULT_CAP, EXPECT_BASE };
