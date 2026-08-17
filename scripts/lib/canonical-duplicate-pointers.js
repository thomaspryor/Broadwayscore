'use strict';

/**
 * Duplicate-pointer cycle detection for byline-cluster cleanup.
 *
 * WHY THIS EXISTS (loves-labours-lost-globe-west-end-2026, 2026-08-17):
 * `audit-review-url-clusters.js` collapses a byline explosion (one URL, many
 * invented critic names) by picking a canonical and pointing every other cluster
 * member's `duplicateOf` at it. It cleared the canonical's own `duplicateOf` but
 * NOT its `duplicateTextOf`, so the canonical was left pointing back at a file
 * that pointed at the canonical — a mutual cycle.
 *
 * That cycle is not inert. review-guards.js:2899-2913 resolves a circular
 * duplicate pair by content fingerprint: same text -> keep the lexically-lower
 * filename, DIFFERENT text -> treat both as legitimate separate reviews and keep
 * BOTH. A scrape artifact on one side (here a Times quiz widget prepended to the
 * canonical's fullText) is enough to make the fingerprints differ, so both files
 * landed in reviews.json under the same URL and validate-data.js failed the
 * "one URL per outlet per show" gate — turning main red.
 *
 * The invariant this module encodes: a canonical (or tombstone) must never carry
 * a duplicate pointer aimed at itself or at any member of the cluster it is the
 * canonical FOR. Pure + fixture-tested so the policy is regression-testable
 * (CLAUDE.md §15 — the test requires() this, it does not restate it).
 */

/** Every field that can express "this file is a duplicate of that file". */
const DUPLICATE_POINTER_FIELDS = ['duplicateOf', 'duplicateTextOf'];

/**
 * How each pointer is cleared. These are NOT interchangeable:
 *  - `duplicateOf` is written back as an explicit `null` (long-standing shape;
 *    downstream readers distinguish "explicitly not a duplicate" from absent).
 *  - `duplicateTextOf` must be DELETED, not nulled — validate-data.js flags a
 *    null `duplicateTextOf` as a field that should have been removed
 *    (review-write-guard.js:578-585 documents the same rule for --fix).
 */
const POINTER_CLEAR_MODE = { duplicateOf: 'null', duplicateTextOf: 'delete' };

/**
 * Decide which duplicate pointers on a canonical/tombstone must be cleared.
 *
 * @param {object} data          the canonical's parsed review-text JSON
 * @param {object} opts
 * @param {string} opts.self     the canonical's own filename (e.g. "times-uk--clive-davis.json")
 * @param {string[]} opts.clusterFiles filenames in the cluster this file is canonical for
 * @returns {{drop: string[], reason: string|null}}
 */
function planCanonicalPointerClear(data, opts = {}) {
  const self = opts.self;
  const members = new Set(Array.isArray(opts.clusterFiles) ? opts.clusterFiles : []);
  const drop = [];
  for (const field of DUPLICATE_POINTER_FIELDS) {
    const target = data ? data[field] : null;
    if (!target || typeof target !== 'string') continue;
    // Self-reference, or a pointer at a file this one is the canonical FOR.
    // Either way the canonical would sit inside a duplicate cycle.
    if (target === self || members.has(target)) drop.push(field);
  }
  return {
    drop,
    reason: drop.length
      ? `${drop.join('+')} pointed back into its own byline cluster`
      : null,
  };
}

/**
 * Apply a plan to a mutable target object, honouring each field's clear mode.
 * Returns true when the object was changed (so callers can skip a no-op write).
 *
 * @param {object} target  object to mutate (the merged canonical payload)
 * @param {{drop: string[]}} plan  result of planCanonicalPointerClear
 */
function applyCanonicalPointerClear(target, plan) {
  if (!target || !plan || !plan.drop || !plan.drop.length) return false;
  let changed = false;
  for (const field of plan.drop) {
    if (POINTER_CLEAR_MODE[field] === 'delete') {
      if (Object.prototype.hasOwnProperty.call(target, field)) {
        delete target[field];
        changed = true;
      }
    } else if (target[field] !== null) {
      target[field] = null;
      changed = true;
    }
  }
  return changed;
}

// NOT provided here on purpose: a general cycle walker. scripts/lib/duplicate-cycle.js
// already owns that (findDuplicateOfCycle / wouldFormDuplicateCycle) and is wired
// into review-write-guard.js's write-time refusal. It walks `duplicateOf` ONLY, so
// a mutual `duplicateTextOf` cycle is still not refused at write time — that gap is
// real but belongs in that shared guard, not in a second competing walker here.

module.exports = {
  DUPLICATE_POINTER_FIELDS,
  POINTER_CLEAR_MODE,
  planCanonicalPointerClear,
  applyCanonicalPointerClear,
};
