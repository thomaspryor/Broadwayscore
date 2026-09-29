/**
 * morning-digest-liveness.js — pure decision for "did today's morning digest
 * reach the owner?" (BRO-4373). No I/O (CLAUDE.md §15).
 *
 * Why: the digest, the opening-night monitor and the Friday inventory sync all
 * run from launchd on the Mac Studio, and LaunchAgents only run after GUI
 * login. FileVault means a reboot leaves the Mac at the login screen, so all
 * three silently stopped for 4.5 days (2026-09-25..29) and nothing told the
 * owner. The digest is the one daily signal that proves the Mac is alive, and
 * Resend's send history (readable from CI) is the one place that proves it
 * was delivered. Complements monitor-scheduled-email-count.js, which checks
 * YESTERDAY at 15:00 UTC and files a card; this checks TODAY and pages.
 *
 * Classification reuses scheduled-email-count-rules.js (the digest's subject
 * pattern + ET day bucketing), so the subject prefix is not duplicated here.
 */
'use strict';

const { buildDailyReport, decideDayMissing } = require('./scheduled-email-count-rules.js');

const CONDITION_KEY = 'mac:morning-digest-missing';

/**
 * @param {object} p
 * @param {Array}  p.emails      Resend GET /emails rows (any recipient)
 * @param {string} p.ownerEmail
 * @param {string} p.dateET      YYYY-MM-DD, the ET day being checked
 * @param {string} [p.apiError]  set when the Resend read failed
 * @returns {{action:'ok'|'page'|'skip', reason:string}}
 *   ok   = digest found (caller re-arms the condition)
 *   page = no digest for dateET
 *   skip = cannot tell (API/config error): NEVER page on this, the caller
 *          logs and exits non-zero so the job goes red instead
 */
function decideMorningDigest({ emails, ownerEmail, dateET, apiError }) {
  if (apiError) return { action: 'skip', reason: `Resend read failed: ${apiError}` };
  if (!ownerEmail) return { action: 'skip', reason: 'OWNER_EMAIL not set' };
  if (!Array.isArray(emails)) return { action: 'skip', reason: 'no email list returned' };
  const days = buildDailyReport(emails, ownerEmail);
  const { primaryFired } = decideDayMissing(days.get(dateET), dateET);
  return primaryFired
    ? { action: 'ok', reason: `morning digest found for ${dateET}` }
    : { action: 'page', reason: `no morning digest to ${ownerEmail} on ${dateET} (ET)` };
}

const ALERT_TITLE = 'This morning\'s digest did not send. The Mac Studio is probably off or logged out';
const ALERT_DESCRIPTION = 'Log in to the Mac Studio. Until then the opening-night monitor and daily jobs are not running.';

module.exports = { decideMorningDigest, CONDITION_KEY, ALERT_TITLE, ALERT_DESCRIPTION };
