'use strict';

/**
 * BRO-7210: the Reddit drafter's "posted-detection skipped" warning was console-only,
 * so a dead post archive let already-posted drafts keep getting "Still ready" /
 * "Updated" emails with nobody told. The drafter's cadence varies (daily, hourly when a
 * draft is due), so the outage is measured in elapsed time: the first failing run is
 * stamped, and once it has been failing DETECTION_OUTAGE_HOURS one worker card is filed
 * via audit-alert.js. A good run clears the stamp and the card. Pure.
 */
const DETECTION_ALERT_KEY = 'reddit-drafts:posted-detection-down';
const DETECTION_OUTAGE_HOURS = 24;

/** ISO stamp of the first run in the current failing streak, or null when healthy. */
function nextFailingSince(prevSince, ok, nowIso) {
  if (ok) return null;
  return prevSince && Number.isFinite(Date.parse(prevSince)) ? prevSince : nowIso;
}

/** @returns {object|null} audit-alert decision; null while a blip (failing, under the threshold) */
function decideRedditDetectionAlert(failingSince, nowMs) {
  if (failingSince) {
    const hours = (nowMs - Date.parse(failingSince)) / 3600000;
    if (!(hours >= DETECTION_OUTAGE_HOURS)) return null;
    return require('./audit-alert').buildAuditAlert({
      conditionKey: DETECTION_ALERT_KEY,
      rows: [`posted detection failing since ${failingSince}`],
      title: () => 'Reddit drafts: posted-detection has been failing for a day or more',
      intro: 'The Reddit opening-post drafter could not read the owner\'s recent posts for over a day, so posted drafts are not recognised and keep generating emails.',
      hint: 'Check the archive endpoint in fetchRecentOwnerPosts (scripts/draft-reddit-opening-posts.js) from a shell, fix or swap the source. Done when data/audit/reddit-post-drafts.json _meta.postedDetection is "ok" after a run.',
    });
  }
  return require('./audit-alert').buildAuditAlert({
    conditionKey: DETECTION_ALERT_KEY, rows: [], title: () => '', intro: '', hint: '',
    resolveReason: 'posted detection succeeded',
  });
}

module.exports = { nextFailingSince, decideRedditDetectionAlert, DETECTION_ALERT_KEY, DETECTION_OUTAGE_HOURS };
