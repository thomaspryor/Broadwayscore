'use strict';
// BRO-7167: the morning import trims the private archive to its total byte budget BEFORE importing, then imports. With
// the archive already at the cap, every new night is refused as over-budget (runs 42271306379, 42394058660, 42504014736
// on 2026-11-06..08: 106846388 bytes > 104857600 total) and the job goes red until the post-import trim, one run late.
// Trim to the cap minus room for the incoming artifacts instead, so the import that follows always fits.
// Lives outside scripts/lib/lane-recorded-nights/ on purpose: that folder is lane code and changing it changes arming.

const MAX_INCOMING_NIGHTS = 4; // headroom is bounded so one huge backlog cannot wipe the archive

/**
 * @param {{maxTotalBytes: number, maxNightBytes: number}} budgets the import module's MAX_TOTAL_BYTES / MAX_NIGHT_BYTES
 * @param {number} incoming how many artifacts are about to be imported
 * @returns {number} the total the archive must be trimmed to before importing
 */
function preImportTotalBytes({ maxTotalBytes, maxNightBytes }, incoming) {
  const room = maxNightBytes * Math.min(Math.max(0, incoming), MAX_INCOMING_NIGHTS);
  return Math.max(0, maxTotalBytes - room);
}

module.exports = { preImportTotalBytes, MAX_INCOMING_NIGHTS };
