'use strict';

/**
 * BRO-7210: the Reddit drafter's "posted-detection skipped" warning was console-only,
 * so a dead post archive let already-posted drafts keep getting "Still ready" /
 * "Updated" emails with nobody told. One skipped run is a transient blip; after
 * DETECTION_FAILURE_THRESHOLD consecutive skipped runs it files one worker card via
 * audit-alert.js, and a good run clears it. Pure.
 */
const DETECTION_ALERT_KEY = 'reddit-drafts:posted-detection-down';
const DETECTION_FAILURE_THRESHOLD = 3;

/** Consecutive skipped runs after this run. */
function nextFailureStreak(prevStreak, ok) {
  return ok ? 0 : (Number.isFinite(prevStreak) && prevStreak > 0 ? Math.floor(prevStreak) : 0) + 1;
}

/** @returns {object|null} audit-alert decision; null while a blip (streak 1..threshold-1) */
function decideRedditDetectionAlert(streak) {
  if (streak > 0 && streak < DETECTION_FAILURE_THRESHOLD) return null;
  return require('./audit-alert').buildAuditAlert({
    conditionKey: DETECTION_ALERT_KEY,
    rows: streak >= DETECTION_FAILURE_THRESHOLD ? [`posted detection skipped ${streak} runs in a row`] : [],
    title: () => 'Reddit drafts: posted-detection has failed several runs in a row',
    intro: 'The Reddit opening-post drafter could not read the owner\'s recent posts for consecutive runs, so posted drafts are not recognised and keep generating emails.',
    hint: 'Check the archive endpoint in fetchRecentOwnerPosts (scripts/draft-reddit-opening-posts.js) from a shell, fix or swap the source. Done when data/audit/reddit-post-drafts.json _meta.postedDetection is "ok" after a run.',
    resolveReason: 'posted detection succeeded',
  });
}

module.exports = { nextFailureStreak, decideRedditDetectionAlert, DETECTION_ALERT_KEY, DETECTION_FAILURE_THRESHOLD };
