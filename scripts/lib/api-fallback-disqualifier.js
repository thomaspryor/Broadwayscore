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
 * NOT A PURE EXTRACTION. The RULES below are character-for-character the inline
 * version's (verified equivalent over all 327 registry paths). The CLI's
 * changed-path collection is NOT: it adds `-z --no-renames`, which strictly
 * WIDENS disqualification by surfacing quoted filenames and rename SOURCES the
 * old invocation hid. See the CLI comment for the two bypasses that closed.
 * Safe direction — it can only disqualify more, never fewer, paths.
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
 *
 * SPLIT (unrelated fix picked up while landing BRO-2531): the pure predicate
 * (disqualifyingPath/NEVER_FALLBACK) now lives in
 * scripts/lib/api-fallback-disqualifier-core.js and is re-exported below
 * unchanged. This file's CLI block still does a real `git diff` spawn, and
 * scripts/lib/audit-push-retry-budgets.js — on the AUDIT_LINT_GENERIC_FORM_
 * ALLOWED allowlist, which requires a zero-hazard transitive require graph —
 * used to require() THIS file for the predicate, pulling that spawn in
 * transitively and failing scripts/lib/safe-form-allowlist.test.mjs on every
 * run. audit-push-retry-budgets.js now requires the -core file directly; this
 * file's own exports and CLI behavior are unchanged. See -core.js's header
 * for the full rationale.
 */

'use strict';

const { disqualifyingPath, NEVER_FALLBACK } = require('./api-fallback-disqualifier-core.js');

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
  // -z and --no-renames are load-bearing, not tidiness (adversarial review,
  // BRO-3663 — both were bypasses in the inline version this replaces):
  //   -z          plain NUL-separated names. Without it git QUOTES any path
  //               containing a tab, newline or non-ASCII byte, so
  //               `data/audit/od<TAB>d.json` arrives as `"data/audit/od\td.json"`
  //               — which no longer startsWith('data/audit/'), silently passing
  //               an unaudited path as clean.
  //   --no-renames  a rename is otherwise reported only as its DESTINATION, so
  //               renaming data/shows.json onto a permitted path hid the
  //               protected source from both guards while the fallback went on
  //               to delete it. Forcing delete+add surfaces the old path.
  const changed = require('child_process')
    .execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, head], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hit = disqualifyingPath(changed, registry);
  if (hit) {
    console.error(`api-fallback-disqualifier: ${hit}`);
    process.exit(1);
  }
  process.exit(0);
}
