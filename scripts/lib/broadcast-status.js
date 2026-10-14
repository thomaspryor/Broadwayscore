'use strict';
/**
 * One reading of a show's opening-night broadcast for the status pages
 * (scripts/opening-night-status.js CLI/Discord and scripts/generate-status-
 * page.js status.html). They used to carry two drifting inline copies.
 *
 * Order matters:
 *   complete      a send observed on any record of the show (findSentRecord)
 *   preview-sent  an owner preview went out today: newer than any skip, so a
 *                 reconsidered send stays visible
 *   not-sent      the owner chose not to send it (discard-broadcast-draft.yml,
 *                 BRO-2935/3087), on the per-show record OR any market/combo
 *                 record naming the show. Terminal: never overdue.
 *   preview-sent-earlier, overdue, waiting
 */
const { findSentRecord } = require('./missed-broadcasts');
const { recordKeysForShow } = require('./broadcast-dismiss');

function isDiscardedShow(sentShows, showId) {
  return recordKeysForShow(sentShows, showId).some((k) => sentShows[k] && sentShows[k].discardedAt);
}

function showBroadcastStatus(sentShows, showId, market, now = new Date()) {
  if (!sentShows) return { state: 'waiting', detail: 'No broadcast data' };

  const completed = findSentRecord(sentShows, showId, market);
  if (completed) {
    return {
      state: 'complete',
      detail: completed.sentAt ? `Broadcast sent at ${new Date(completed.sentAt).toLocaleString()}` : 'Broadcast sent',
      reviewCount: completed.reviewCount,
      sentAt: completed.sentAt,
    };
  }

  const today = now.toISOString().slice(0, 10);
  const preview = sentShows[`preview:${market}:${showId}:${today}`];
  if (preview) {
    return {
      state: 'preview-sent',
      detail: `Preview sent to ${preview.previewTo || 'owner'} at ${new Date(preview.sentAt).toLocaleTimeString()}`,
      reviewCount: preview.reviewCount,
    };
  }

  if (isDiscardedShow(sentShows, showId)) {
    return { state: 'not-sent', detail: 'Not sent (owner chose to skip this email)' };
  }

  const earlier = Object.keys(sentShows).filter((k) => k.startsWith('preview:') && String(k.split(':')[2] || '').split('+').includes(showId)).sort();
  if (earlier.length) {
    const lastKey = earlier[earlier.length - 1];
    return { state: 'preview-sent-earlier', detail: `Last preview: ${lastKey.split(':').pop()} (${sentShows[lastKey].reviewCount} reviews)` };
  }

  const overdue = sentShows[`overdue-alert:${showId}`];
  if (overdue) {
    return { state: 'overdue', detail: `Overdue alert sent at ${new Date(overdue.sentAt).toLocaleString()}` };
  }

  return { state: 'waiting', detail: 'Awaiting reviews' };
}

module.exports = { showBroadcastStatus, isDiscardedShow };
