'use strict';
/**
 * "Is the private core-data clone actually current?" — distance from origin,
 * not wall-clock age.
 *
 * THE INCIDENT THIS EXISTS TO PREVENT (2026-09-05, PR #793): a session ran the
 * full CI unit batch (~10,700 tests) locally against a clone whose HEAD was
 * only ~30 minutes old — check-data-health.js reported "Data healthy … Updated:
 * 30m ago" — while origin had moved 8 commits ahead. CI checks the data repo
 * out at ORIGIN's head, so CI was red on a data-dependent test the local run
 * could not reproduce. Hours went into hunting a phantom code defect; the
 * failure appeared on the first run after fast-forwarding the clone.
 *
 * Age and currency are different questions. A clone can be minutes old and
 * still be behind: the data repo takes CI commits roughly every 30 minutes, so
 * "recent" says nothing about "same as what CI will use". check-data-health.js
 * already answers the age question (and was hardened for it on 2026-09-02);
 * this answers the currency one.
 *
 * Kept as a pure function (CLAUDE.md §15) so the thresholds are testable
 * without a git repo or a network call.
 */

/** Commits behind origin at which a local test run stops being trustworthy. */
const BEHIND_WARN = 1;
/** Behind this far, a green local run says nothing about CI. */
const BEHIND_LOUD = 5;

/**
 * Classify how much a local data clone can be trusted.
 *
 * @param {object} input
 * @param {number|null} input.behindCount - commits HEAD is behind origin, or
 *   null when it could not be determined (no remote ref, not a clone).
 * @param {boolean} input.refsFetched - whether remote refs were refreshed in
 *   this invocation. Without a fetch, behindCount is a LOWER BOUND: the
 *   remote-tracking ref itself may be stale, so 0 does not prove current.
 * @returns {{level: 'ok'|'unknown'|'behind'|'far-behind', behindCount: number|null,
 *   trustworthy: boolean, message: string, remedy: string|null}}
 */
function classifyDataFreshness({ behindCount, refsFetched } = {}) {
  const remedy =
    'git -C "$BSC_DATA_REPO" fetch origin main && git -C "$BSC_DATA_REPO" merge --ff-only origin/main';

  if (behindCount === null || behindCount === undefined || Number.isNaN(behindCount)) {
    return {
      level: 'unknown',
      behindCount: null,
      trustworthy: false,
      message:
        'Cannot tell whether core data is current (no origin ref). A local test ' +
        'run may not match CI, which checks out the data repo at origin.',
      remedy,
    };
  }

  if (behindCount >= BEHIND_LOUD) {
    return {
      level: 'far-behind',
      behindCount,
      trustworthy: false,
      message:
        `Core data is ${behindCount} commits behind origin. CI checks out ` +
        'origin, so a GREEN local test run proves nothing about CI — and a red ' +
        'CI test may be unreproducible locally. Fast-forward before trusting ' +
        'either result.',
      remedy,
    };
  }

  if (behindCount >= BEHIND_WARN) {
    return {
      level: 'behind',
      behindCount,
      trustworthy: false,
      message:
        `Core data is ${behindCount} commit(s) behind origin — data-dependent ` +
        'tests may disagree with CI.',
      remedy,
    };
  }

  if (!refsFetched) {
    return {
      level: 'unknown',
      behindCount: 0,
      trustworthy: false,
      message:
        'Core data matches the last KNOWN origin ref, but those refs were not ' +
        'refreshed — origin may have moved. Re-check with a fetch before ' +
        'trusting a data-dependent test result.',
      remedy,
    };
  }

  return {
    level: 'ok',
    behindCount: 0,
    trustworthy: true,
    message: 'Core data is level with origin.',
    remedy: null,
  };
}

module.exports = { BEHIND_WARN, BEHIND_LOUD, classifyDataFreshness };
