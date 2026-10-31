'use strict';
/**
 * Verdict on the Cyrus webhook relay, from the status file the drain writes.
 *
 * The relay is the only path Linear has to reach Cyrus on this Mac, and its
 * whole failure mode is silence: the drain stops, the queue backs up, and
 * @mentions simply never get answered. Nothing about that is visible unless
 * something reads the status file, which is what this is for.
 *
 * Pure so it can be tested against fixtures — the caller does the file read.
 */

// The drain polls every 2s; a status file older than this means the launchd
// job is dead or wedged, not merely idle.
const STALE_STATUS_MS = 10 * 60 * 1000;

// Deliveries clear in seconds. Anything sitting this long is stuck.
const BACKLOG_AGE_SECONDS = 300;

/**
 * @param {object|null} status parsed webhook-drain-status.json, or null if absent
 * @param {number} nowMs
 * @returns {{status:'ok'|'warn'|'error'|'unknown', message:string|null}}
 */
function assessCyrusRelay(status, nowMs = Date.now()) {
  if (status === null || status === undefined) {
    // Absent on machines that don't run Cyrus — unknown, never an alarm.
    return { status: 'unknown', message: null };
  }

  const writtenMs = Date.parse(status.at);
  if (!Number.isFinite(writtenMs)) {
    return { status: 'error', message: 'Cyrus relay: status file is unreadable — the drain may not be running.' };
  }

  const ageMin = Math.round((nowMs - writtenMs) / 60000);
  if (nowMs - writtenMs > STALE_STATUS_MS) {
    return {
      status: 'error',
      message: `Cyrus relay: the webhook drain has not checked in for ${ageMin} min — Linear @mentions are going nowhere. Restart: launchctl kickstart -k gui/$(id -u)/com.broadwayscore.cyrus-webhook-drain`,
    };
  }

  if (status.ok === false) {
    return {
      status: 'error',
      message: `Cyrus relay: the drain cannot reach the relay (${String(status.error || 'unknown error').slice(0, 120)}).`,
    };
  }

  const oldest = Number(status.oldestAgeSeconds) || 0;
  const depth = Number(status.depth) || 0;
  if (oldest > BACKLOG_AGE_SECONDS) {
    return {
      status: 'warn',
      message: `Cyrus relay: ${depth} webhook${depth === 1 ? '' : 's'} stuck in the queue, oldest ${Math.round(oldest / 60)} min — Cyrus is not answering Linear.`,
    };
  }

  return { status: 'ok', message: null };
}

module.exports = { assessCyrusRelay, STALE_STATUS_MS, BACKLOG_AGE_SECONDS };
