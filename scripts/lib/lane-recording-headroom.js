'use strict';
// BRO-7167: the morning import trims the private archive to its total byte budget BEFORE importing, then imports. With
// the archive already at the cap, every new night is refused as over-budget (runs 42271306379, 42394058660, 42504014736
// on 2026-11-06..08: 106846388 bytes > 104857600 total) and the job goes red until the post-import trim, one run late.
// Trim to the cap minus room for the incoming artifacts instead, so the import that follows always fits.
// Lives outside scripts/lib/lane-recorded-nights/ on purpose: that folder is lane code and changing it changes arming.

const MAX_INCOMING_NIGHTS = 4; // headroom is bounded so one huge backlog cannot wipe the archive

/**
 * @param {{maxTotalBytes: number, maxNightBytes: number}} budgets the import module's MAX_TOTAL_BYTES / MAX_NIGHT_BYTES
 * @param {number|number[]} incoming how many artifacts are about to be imported, or each one's size in bytes (each is
 *   reserved at most maxNightBytes, so a small or skipped artifact does not cost the archive a whole night)
 * @returns {number} the total the archive must be trimmed to before importing
 */
function preImportTotalBytes({ maxTotalBytes, maxNightBytes }, incoming) {
  const sizes = Array.isArray(incoming) ? incoming.map((b) => Math.min(Math.max(0, Number(b) || 0), maxNightBytes)) : Array(Math.max(0, incoming | 0)).fill(maxNightBytes);
  const room = sizes.sort((a, b) => b - a).slice(0, MAX_INCOMING_NIGHTS).reduce((t, b) => t + b, 0);
  return Math.max(0, maxTotalBytes - room);
}

/**
 * An over-budget artifact whose night is older than every night the archive keeps would be evicted by retention the
 * moment it was imported, so refusing it loses nothing and must not turn the job red (five Sep 28 to Oct 29 nights did).
 * @param {string} night YYYY-MM-DD of the refused artifact
 * @param {string[]} archivedNights nights currently in the archive (any show)
 */
function isBeyondRetention(night, archivedNights) {
  const isNight = (n) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(n));
  const kept = (archivedNights || []).filter(isNight).sort(); // a stray directory name never decides what is old
  return isNight(night) && kept.length > 0 && String(night) < kept[0];
}

module.exports = { preImportTotalBytes, isBeyondRetention, MAX_INCOMING_NIGHTS };
