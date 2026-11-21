/**
 * systematic-fix-detection.js — decides whether a spot fix generalizes to a
 * dataset-wide "systematic" fix proposal (generate-remediation-plan.js step 8).
 *
 * HARD RULE — no value-generalization. An earlier version generalized ANY
 * data-edit by matching other shows with the same oldValue in the same field.
 * That is only ever valid when the VALUE ITSELF is the anomaly (a typo'd
 * venue). For enumerated fields it is catastrophic: on 2026-07-31 a spot fix
 * flipping one show's status "open"→"closed" generated a proposal to close
 * ALL 147 other open shows — "open" is a state most shows legitimately share,
 * not a defect. The same failure shape applies to type, isRevival, and every
 * date field (two shows sharing a closing date is coincidence, not a bug).
 * Sharing a value is not sharing a defect.
 *
 * The ONLY generalization that survives is the combined-creativeTeam-roles
 * split ("Director, Scenic Design" → two entries): the PATTERN (comma in the
 * role string) identifies the defect independent of any per-show value, and
 * the transform is mechanical. New systematic patterns must meet that same
 * bar — the defect must be recognizable from the shape of the data alone —
 * and must be added here WITH tests, never inferred from value equality.
 */
'use strict';

function detectSystematicIssue(plan, shows) {
  const showsList = Array.isArray(shows) ? shows : Object.values(shows);

  for (const action of (plan.actions || [])) {
    if (action.type !== 'data-edit') continue;

    // Pattern: combined roles in creativeTeam (comma-separated). Trigger only
    // when the spot fix actually SPLIT a comma-role — an old entry with a
    // ", "-joined role whose count grew. A fix that merely ADDS a credit
    // (also newRoles > oldRoles) is not a split and must not launch a
    // dataset-wide transform.
    if (action.field === 'creativeTeam') {
      const oldEntries = action.oldValue || [];
      const newEntries = action.newValue || [];
      const hadCombinedRole = oldEntries.some(ct => ct.role && ct.role.includes(', '));
      if (hadCombinedRole && newEntries.length > oldEntries.length) {
        return detectCombinedRoles(showsList, action.showId);
      }
    }
  }

  return null;
}

function detectCombinedRoles(showsList, excludeShowId) {
  const matches = [];
  for (const show of showsList) {
    if (!show.creativeTeam || show.id === excludeShowId) continue;
    for (const ct of show.creativeTeam) {
      if (ct.role && ct.role.includes(', ')) {
        matches.push({
          showId: show.id,
          showTitle: show.title,
          name: ct.name,
          combinedRole: ct.role,
          splitRoles: ct.role.split(', ').map(r => r.trim()),
        });
      }
    }
  }

  if (matches.length === 0) return null;

  const affectedShows = new Set(matches.map(m => m.showId));

  return {
    totalMatches: matches.length,
    showCount: affectedShows.size,
    summary: `${matches.length} combined creativeTeam roles across ${affectedShows.size} shows need splitting`,
    description: `The spot fix split a combined role (e.g., "Director, Scenic Design") into separate entries. The same pattern exists in ${matches.length} other creativeTeam entries across ${affectedShows.size} shows.`,
    steps: [
      `Scan all shows for creativeTeam entries with comma-separated roles`,
      `Split each combined role into separate entries (e.g., "Director, Scenic Design" → "Director" + "Scenic Design")`,
      `${affectedShows.size} shows affected with ${matches.length} combined roles total`,
    ],
    riskLevel: matches.length > 50 ? 'Medium' : 'Low',
    actions: [{
      type: 'batch-transform',
      file: 'shows.json',
      field: 'creativeTeam',
      transform: 'split-comma-roles',
      affectedShows: affectedShows.size,
      affectedEntries: matches.length,
      description: `Split all ${matches.length} comma-separated creativeTeam roles into individual entries across ${affectedShows.size} shows`,
    }],
    sampleEntries: matches.slice(0, 5).map(m => ({
      showTitle: m.showTitle,
      showId: m.showId,
      field: 'creativeTeam',
      currentValue: `${m.name} (${m.combinedRole})`,
      proposedChange: `Split into: ${m.splitRoles.map(r => `${m.name} (${r})`).join(' + ')}`,
    })),
  };
}

module.exports = { detectSystematicIssue, detectCombinedRoles };
