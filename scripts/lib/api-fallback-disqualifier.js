#!/usr/bin/env node
/**
 * Git Data API fallback path disqualifier — ONE definition (BRO-3663).
 *
 * push-via-git-api.sh overlays OUR version of every touched path onto whatever
 * the remote tip currently holds. That is safe only for paths where a
 * whole-file overlay cannot silently discard a concurrent writer's work. This
 * module is the single predicate that decides which paths those are.
 *
 * WHY IT EXISTS AS A MODULE (CLAUDE.md §15):
 * this predicate used to be an inline `node -e` heredoc inside
 * push-with-retry.sh, and `classifyPushFallbackSafety` in
 * audit-push-retry-budgets.js:82-116 is a hand-maintained SECOND copy of it
 * that describes itself as a "precise mirror". The two have already drifted
 * once (BRO-3348, caught by push-with-retry.sh's stranded-commit-cascade
 * test). BRO-3663 needed a THIRD evaluation — the early-break gate — which is
 * the point at which copy-paste stops being defensible. The shell calls this
 * file; there is one definition to keep correct.
 *
 * DISQUALIFYING CONDITIONS (unchanged from the inline version they replace):
 *   - a union-merge MANAGED file that has no apiFallbackMerge coverage. With
 *     coverage, push-via-git-api.sh re-runs that merge function against the
 *     live remote tip on every retry instead of overlaying (BRO-2413), so the
 *     path is fine.
 *   - data/shows.json or data/reviews.json, ever (NEVER_FALLBACK).
 *   - a data/audit/ path that is neither MANAGED, apiFallbackSafe nor
 *     apiFallbackMerge — i.e. nobody has hand-verified its writer count.
 *     360 of the 476 data/audit/*.json files on disk are still in this state.
 *
 * FAILS CLOSED. Every caller treats ANY non-zero exit as "disqualified", not
 * just exit 1 — a syntax error, a thrown exception or a missing registry must
 * never read as a clean diff (Codex adversarial finding, BRO-2413).
 *
 * CLI:  node api-fallback-disqualifier.js <base-ref> <head-ref>
 *       exit 0 = no disqualifying path, safe to use the API fallback
 *       exit 1 = a disqualifying path is present (prints it to stderr)
 *       exit >1 = the check itself failed; callers treat this as disqualified
 *
 * Tested by scripts/lib/api-fallback-disqualifier.test.mjs — that test
 * require()s disqualifyingPath() rather than restating the rules.
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
  const { MANAGED = [], API_FALLBACK_SAFE = [], API_FALLBACK_MERGE = [] } = registry || {};
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

if (require.main === module) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('usage: api-fallback-disqualifier.js <base-ref> <head-ref>');
    process.exit(2);
  }
  // Any throw here exits non-zero via the default handler, which every caller
  // already treats as disqualified — that is the fail-closed direction.
  const registry = require('./reconcile-merged-json.js');
  const changed = require('child_process')
    .execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const hit = disqualifyingPath(changed, registry);
  if (hit) {
    console.error(`api-fallback-disqualifier: ${hit}`);
    process.exit(1);
  }
  process.exit(0);
}
