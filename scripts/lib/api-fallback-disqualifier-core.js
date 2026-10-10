#!/usr/bin/env node
/**
 * Pure predicate half of scripts/lib/api-fallback-disqualifier.js, split out
 * (unrelated fix picked up while landing BRO-2531) so it can be require()'d
 * by scripts/lib/audit-push-retry-budgets.js (and any future library
 * consumer) with ZERO spawn/fs-write text anywhere in this file's require
 * graph. scripts/audit-safe-form-allowlist.js's transitive scan is a plain
 * per-line regex over file text — it has no idea `execFileSync` inside
 * api-fallback-disqualifier.js's `if (require.main === module)` CLI block is
 * unreachable via require(); it just sees the line and flags it. Before this
 * split, audit-push-retry-budgets.js (on the AUDIT_LINT_GENERIC_FORM_ALLOWED
 * allowlist, which requires a zero-hazard transitive require graph) pulled
 * that CLI block in transitively and failed scripts/lib/safe-form-allowlist
 * .test.mjs's "every allowlisted basename is write-free across its require
 * graph" check on every run since api-fallback-disqualifier.js was introduced
 * (BRO-3663) — the file's own README explicitly disallows discharging this
 * class of failure by adding a second name to TRANSITIVE_SCAN_BASELINE
 * ("a NEW basename must clear both bars"), so severing the graph (this file)
 * is the sanctioned fix, not a baseline entry.
 *
 * api-fallback-disqualifier.js re-exports everything from here unchanged, so
 * its own CLI behavior and scripts/lib/api-fallback-disqualifier.test.mjs are
 * both untouched by this split.
 *
 * See scripts/lib/api-fallback-disqualifier.js's header comment for the rules
 * themselves and why they exist as one definition.
 */

'use strict';

const NEVER_FALLBACK = ['data/shows.json', 'data/reviews.json'];

/**
 * The one rule. Pure — takes the already-computed changed-path list and the
 * registry lists, so the test can drive it without a git repo.
 *
 * Path matching uses endsWith() against the registry entry with its leading
 * `data/` stripped, which is exactly what the inline version did: the shell
 * passes repo-relative paths, but callers have historically run from both the
 * repo root and a worktree subdirectory.
 *
 * @param {string[]} changed        repo-relative changed paths
 * @param {{MANAGED: {file: string}[], API_FALLBACK_SAFE: {file: string}[], API_FALLBACK_MERGE: {file: string}[]}} registry
 * @returns {string|null} the first disqualifying path, or null when all clear
 */
function disqualifyingPath(changed, registry) {
  const { MANAGED, API_FALLBACK_SAFE, API_FALLBACK_MERGE } = registry || {};
  // NO `= []` defaults here, deliberately (adversarial review, BRO-3663). A
  // registry that loads but stops exporting MANAGED would default to "nothing
  // is managed" — a clean verdict — and the fallback would be permitted to
  // overlay MANAGED files. That is a fail-OPEN in a guard whose entire job is
  // to fail closed. The inline version this replaces threw on `undefined.some`
  // and the shell turned that into "disqualified"; throwing preserves it.
  for (const [name, list] of [['MANAGED', MANAGED], ['API_FALLBACK_SAFE', API_FALLBACK_SAFE], ['API_FALLBACK_MERGE', API_FALLBACK_MERGE]]) {
    if (!Array.isArray(list)) {
      throw new TypeError(`api-fallback-disqualifier: registry.${name} is not an array (got ${typeof list}) — refusing to answer, which fails closed`);
    }
  }
  const matches = (list) => (f) => list.some((m) => f.endsWith(String(m.file).replace(/^data\//, '')));
  const isManaged = matches(MANAGED);
  const isApiFallbackSafe = matches(API_FALLBACK_SAFE);
  const isApiFallbackMergeable = matches(API_FALLBACK_MERGE);
  const isNeverFallback = (f) => NEVER_FALLBACK.some((p) => f === p || f.endsWith('/' + p));

  return (changed || []).find((f) =>
    (isManaged(f) && !isApiFallbackMergeable(f)) ||
    isNeverFallback(f) ||
    (f.startsWith('data/audit/') && !isManaged(f) && !isApiFallbackSafe(f) && !isApiFallbackMergeable(f))
  ) || null;
}

module.exports = { disqualifyingPath, NEVER_FALLBACK };
