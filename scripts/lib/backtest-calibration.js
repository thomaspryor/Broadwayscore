'use strict';

// Compare calibrated and disabled options on the SAME current corpus. Absolute
// MAE ceilings and inside counts measure data health, not a code regression.
function calibrationFailures(live, disabled) {
  const failures = [];
  for (const [label, group] of [['live', live], ['disabled', disabled]]) {
    if (!group || !Number.isInteger(group.n) || group.n <= 0
      || !Number.isFinite(group.newMae) || group.newMae < 0
      || !Number.isInteger(group.newInside) || group.newInside < 0 || group.newInside > group.n) {
      failures.push(`${label} summary is missing, empty or invalid`);
    }
  }
  if (failures.length) return failures;
  if (live.n !== disabled.n) failures.push(`cohort changed: live ${live.n}, disabled ${disabled.n}`);
  if (live.newMae >= disabled.newMae) failures.push(`calibration lost its MAE gain: live ${live.newMae}, disabled ${disabled.newMae}`);
  if (live.newInside < disabled.newInside) failures.push(`calibration reduced inside count: live ${live.newInside}, disabled ${disabled.newInside}`);
  return failures;
}

module.exports = { calibrationFailures };
