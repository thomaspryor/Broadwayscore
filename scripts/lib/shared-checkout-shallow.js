'use strict';
/**
 * Health-digest row for "the shared checkout is shallow" (BRO-2049).
 *
 * The Mac Studio's ~/Broadwayscore stayed shallow undetected from about 2026-07-26 to 2026-08-14
 * (a --shallow-since fetch). push-with-retry.sh, landing-verify.js and the churn audit each noticed
 * it only when they happened to run into it, and each just degraded its own output, so no persistent,
 * dashboard-visible signal existed. A shallow checkout silently breaks every session's did-it-land
 * ancestry proof and nearly caused a false re-push on 2026-08-14.
 *
 * Pure decision, no I/O: the caller reads the state (landing-verify.isShallowRepo against the
 * canonical main checkout) and hands it over.
 *
 * CI and cloud sandboxes are shallow BY DESIGN (fetch-depth 1, depth-limited clones) and have no
 * shared Mac checkout to inspect, so the row is a plain pass there; flagging them would turn the
 * digest red on every run for something that is correct.
 */

/**
 * @param {{ci: boolean, shallow: boolean|null, root?: string}} input
 *   ci: running in GitHub Actions or a cloud sandbox
 *   shallow: result of the shallow check on the shared checkout; null = could not be read
 * @returns {{name: string, status: 'pass'|'warn', message: string, hint?: string}}
 */
function assessSharedCheckoutShallow({ ci, shallow, root = '~/Broadwayscore' } = {}) {
  const name = 'Infra: shared checkout depth';
  if (ci) {
    return { name, status: 'pass', message: 'Skipped in CI/cloud (the shared checkout is the Mac Studio\'s; CI and sandbox checkouts are shallow by design)' };
  }
  if (shallow === null || shallow === undefined) {
    return {
      name,
      status: 'warn',
      message: `Could not read the shallow state of the shared checkout (${root})`,
      hint: `Check that ${root} is a git checkout: git -C ${root} rev-parse --is-shallow-repository`,
    };
  }
  if (shallow) {
    return {
      name,
      status: 'warn',
      message: `The shared checkout (${root}) is SHALLOW: did-it-land ancestry proofs cannot be trusted until it has full history`,
      hint: `Run: git -C ${root} fetch --unshallow origin`,
    };
  }
  return { name, status: 'pass', message: 'Shared checkout has full history' };
}

module.exports = { assessSharedCheckoutShallow };
