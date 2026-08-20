/**
 * Multi-show feedback report handling.
 *
 * The feedback pipeline used to carry exactly one showId end-to-end. A report
 * naming TWO shows with the same bug (issue #515: "3 Summers of Lincoln" +
 * "The Family Album" both had a wrong venue city) got a single showId
 * resolved by the diagnosis step, so relevantFiles/auto-fix only ever
 * touched the first show and the second one silently stayed broken while the
 * GitHub issue closed as COMPLETED.
 *
 * These are the pure decision functions the diagnosis step (which show IDs
 * does this report reference?) and the auto-fix executor (did every
 * referenced show get fixed, or only some?) both need — kept here and
 * required by both scripts + their tests instead of re-implemented per file.
 */

/**
 * Normalizes a diagnosis payload's show reference into a canonical showIds[]
 * array. Prefers an already-set `showIds` (the canonical field once a
 * DIAGNOSIS_JSON has been through process-feedback.yml's payload builder),
 * falls back to `resolvedShowIds` (set by diagnoseBug from real catalog
 * matches against the report's show field + message text), then falls back
 * to the single legacy `showId` field for diagnoses created before either
 * array existed.
 */
function normalizeDiagnosisShowIds(diagnosis) {
  if (Array.isArray(diagnosis?.showIds) && diagnosis.showIds.length > 0) {
    return [...new Set(diagnosis.showIds.filter(Boolean))];
  }
  if (Array.isArray(diagnosis?.resolvedShowIds) && diagnosis.resolvedShowIds.length > 0) {
    return [...new Set(diagnosis.resolvedShowIds.filter(Boolean))];
  }
  if (diagnosis?.showId) return [diagnosis.showId];
  return [];
}

/**
 * Given per-show auto-fix outcomes, decides whether the bug report is fully
 * resolved, partially resolved, or not resolved at all — and builds the
 * comment body auto-fix-feedback-bug.js posts to the GitHub issue either way.
 *
 * A report naming N shows must NEVER report `action: 'fixed'` (which closes
 * the issue as COMPLETED) unless every one of those N shows actually got a
 * change applied. That is the bug this function exists to prevent.
 *
 * @param {Array<{show: {id: string, title?: string}, applied: string[], skipped?: string[], error?: string}>} perShowResults
 * @param {string[]} [unresolvedShowIds] - show IDs referenced in the diagnosis that weren't found in shows.json at all
 * @returns {{action: 'fixed'|'partial'|'skipped', comment: string}}
 */
function summarizeShowFixOutcomes(perShowResults, unresolvedShowIds = []) {
  const anyApplied = perShowResults.some((r) => r.applied && r.applied.length > 0);
  const totalShows = perShowResults.length + unresolvedShowIds.length;

  const showLines = perShowResults.map((r) => {
    const title = r.show?.title || r.show?.id || 'unknown show';
    if (r.applied && r.applied.length > 0) {
      return `**${title}** — Fixed\n${r.applied.map((a) => `  - ${a}`).join('\n')}`;
    }
    const reason = (r.skipped && r.skipped[0]) || r.error || 'no changes identified';
    return `**${title}** — Not fixed (${reason})`;
  });
  for (const id of unresolvedShowIds) {
    showLines.push(`**${id}** — Not fixed (show not found in shows.json)`);
  }

  if (!anyApplied) {
    return {
      action: 'skipped',
      comment: `## Requires Manual Review\n\nNo edits could be applied.\n\n${showLines.join('\n\n')}\n\n---\n*Auto-processed by feedback pipeline*`,
    };
  }

  const allFixed = unresolvedShowIds.length === 0 &&
    perShowResults.every((r) => r.applied && r.applied.length > 0);

  if (allFixed) {
    return {
      action: 'fixed',
      comment: `## Fix Applied\n\n${showLines.join('\n\n')}\n\nThe fix will be live within a few minutes after deployment.\n\n---\n*Auto-fixed by feedback pipeline*`,
    };
  }

  return {
    action: 'partial',
    comment: `## Partially Fixed\n\nThis report named ${totalShows} show(s). Not every show could be auto-fixed — leaving this issue open for manual review of the remainder.\n\n${showLines.join('\n\n')}\n\nThe applied fix(es) will be live within a few minutes after deployment.\n\n---\n*Auto-processed by feedback pipeline*`,
  };
}

module.exports = { normalizeDiagnosisShowIds, summarizeShowFixOutcomes };
