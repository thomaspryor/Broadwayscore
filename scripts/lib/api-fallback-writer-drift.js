'use strict';
/**
 * Drift detector for scripts/lib/core-data-merge-registry.js's
 * `apiFallbackSafe` entries (task: data-health-check.yml push-race
 * hardening, session 2026-08-22, plan-reviewed).
 *
 * WHAT THIS CHECKS
 * -----------------
 * push-with-retry.sh's Git Data API fallback disqualifier grants a live
 * "ours wins outright" bypass to any `data/audit/*` path registered with
 * `apiFallbackSafe: true`. That grant is only safe if the entry's claim —
 * "exactly one workflow writes this file, and its own concurrency group
 * prevents that workflow from racing itself" — stays true over time. This
 * module re-derives the claim from the real workflow files and flags drift:
 * a second writer appearing (e.g. a new cron copy-pasting an existing `git
 * add` line) is exactly the failure class a plan-review pre-mortem and the
 * structure reviewer both flagged (task's own plan-review record).
 *
 * HINT ONLY, NEVER AUTHORITATIVE (Codex/gpt-5.4-mini + Gemini plan-review
 * finding). Static regex matching over workflow YAML text has real blind
 * spots — a writer reached only through a shared helper script whose
 * invocation doesn't literally contain the target path string, or a
 * dynamically-constructed path, is invisible here. A PASS from this module
 * does NOT certify a NEW entry as safe to add — only a human, grepping and
 * reading the actual workflow logic (the same bar `verifiedBy` documents),
 * does that. A FAIL/gap from this module on an EXISTING entry is the
 * actionable signal: it means the registry's claim needs re-verification
 * before the next push relies on it — remove `apiFallbackSafe: true` from
 * the entry (or fix `concurrencyGroup`) once confirmed, matching how
 * `deferredReason` documents a `'deferred'` status is a deliberate parked
 * decision, not a silent gap.
 *
 * Pure functions only (project rule §15) — no fs reads here. The colocated
 * test (api-fallback-writer-drift.test.mjs) supplies both synthetic
 * fixtures (proving the concurrencyGroup escape hatch doesn't false-positive
 * the way a naive "2+ writers = gap" rule would on the grosses.json shape)
 * and a live-repo assertion (reading the real workflow files) that the
 * actual registered entries still hold.
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Workflow files (by name) whose text contains a `git add`/`git-add-
 * existing.sh` reference to `data/<basename>`. Matches the two real staging
 * shapes seen across this repo's workflows: an inline `git add data/audit/
 * foo.json` and the shared `bash scripts/lib/git-add-existing.sh ... data/
 * audit/foo.json ...` helper.
 *
 * @param {string} dataPath repo-relative path, e.g. 'data/audit/foo.json'
 * @param {Record<string,string>} workflowTexts {filename: raw yaml text}
 * @returns {string[]} workflow filenames that write this path, in
 *   Object.entries iteration order (insertion order of workflowTexts)
 */
function findWritingWorkflows(dataPath, workflowTexts) {
  const basename = dataPath.replace(/^data\//, '');
  const re = new RegExp(`(?:git add|git-add-existing\\.sh)[^\\n]*\\bdata/${escapeRegExp(basename)}\\b`);
  const writers = [];
  for (const [wfFile, text] of Object.entries(workflowTexts || {})) {
    if (re.test(text)) writers.push(wfFile);
  }
  return writers;
}

/**
 * A workflow's own top-level `concurrency.group:` value, or null if absent
 * or effectively non-serializing.
 *
 * A group templated on `github.run_id` (or similar per-run tokens) is
 * unique to every single invocation — it can never actually serialize two
 * runs of the same workflow against each other, so it does not count as
 * real protection even though the YAML key is present.
 *
 * @param {string} yamlText raw workflow file contents
 * @returns {string|null}
 */
function extractConcurrencyGroup(yamlText) {
  const m = /^concurrency:[^\S\n]*\n[^\S\n]*group:[^\S\n]*([^\n#]+)/m.exec(String(yamlText || ''));
  if (!m) return null;
  const group = m[1].trim();
  if (!group) return null;
  if (/run_id/.test(group)) return null;
  return group;
}

/**
 * Check one apiFallbackSafe registry entry against real workflow text.
 *
 * @param {{file:string, concurrencyGroup?:string}} entry a
 *   CORE_DATA_MERGE_REGISTRY entry with `apiFallbackSafe: true`; `file` is
 *   the bare (no `data/` prefix) path as stored in the registry
 * @param {Record<string,string>} workflowTexts {filename: raw yaml text}
 * @returns {{ok:boolean, writers:string[], reason?:string, groups?:(string|null)[]}}
 */
function checkEntry(entry, workflowTexts) {
  const dataPath = `data/${entry.file}`;
  const writers = findWritingWorkflows(dataPath, workflowTexts);

  if (writers.length === 0) {
    return {
      ok: false,
      writers,
      reason: 'no writer found via static git-add scan — path may have moved, or is written only through a dynamic/helper call this check cannot see (re-verify by hand, do not assume safe)',
    };
  }
  if (writers.length === 1) return { ok: true, writers };

  // 2+ writers is only a non-gap when EVERY writer declares the SAME
  // concurrency group as the entry's own claim — the grosses.json shape
  // (two writers, mutually exclusive via a shared group), not a true
  // single writer. This is the escape hatch a naive "2+ writers = gap"
  // rule would miss, and the plan-review design reviewer's finding this
  // module exists to not repeat.
  const groups = writers.map((w) => extractConcurrencyGroup(workflowTexts[w]));
  const allMatchClaimed = entry.concurrencyGroup && groups.every((g) => g === entry.concurrencyGroup);
  if (allMatchClaimed) return { ok: true, writers, groups };

  return {
    ok: false,
    writers,
    groups,
    reason: `${writers.length} writers found; not all share the claimed concurrencyGroup '${entry.concurrencyGroup}' (found: ${groups.map((g) => g || '(none)').join(', ')})`,
  };
}

module.exports = { findWritingWorkflows, extractConcurrencyGroup, checkEntry };
