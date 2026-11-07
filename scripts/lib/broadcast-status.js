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
const { findSentRecord, isSideKey } = require('./missed-broadcasts');
const { recordKeysForShow } = require('./broadcast-dismiss');

/**
 * The discarded record that settles this show, or null. Only the show's
 * CURRENT broadcast counts: its per-show mirror, or a record sharing the
 * mirror's draftId. A stale older combo that was discarded must not hide a
 * newer draft still waiting (the sweep reads the mirror too). With no mirror,
 * any record naming the show counts (BRO-3087 retro-review, BRO-5261).
 */
function discardedRecordForShow(sentShows, showId) {
  const shows = sentShows || {};
  const own = shows[showId];
  if (own) {
    if (own.discardedAt) return own;
    if (!own.draftId) return null;
    const key = recordKeysForShow(shows, showId).find((k) => shows[k] && shows[k].draftId === own.draftId && shows[k].discardedAt);
    return key ? shows[key] : null;
  }
  const key = recordKeysForShow(shows, showId).find((k) => shows[k] && shows[k].discardedAt);
  return key ? shows[key] : null;
}

function isDiscardedShow(sentShows, showId) {
  return !!discardedRecordForShow(sentShows, showId);
}

/** preview:<market>:<id>[+<id>...]:<date> keys that include this show. */
function previewKeysForShow(sentShows, showId) {
  return Object.keys(sentShows).filter((k) => isSideKey(k) && k.startsWith('preview:') && String(k.split(':')[2] || '').split('+').includes(showId));
}

/** Oldest first by the key's date, not by its market/show part. */
const byPreviewDate = (a, b) => String(a.split(':')[3] || '').localeCompare(String(b.split(':')[3] || ''));

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
  // Any of today's previews naming the show, combo previews included.
  const todayKey = previewKeysForShow(sentShows, showId).filter((k) => k.split(':')[3] === today).pop();
  const preview = sentShows[`preview:${market}:${showId}:${today}`] || (todayKey ? sentShows[todayKey] : null);
  if (preview) {
    return {
      state: 'preview-sent',
      detail: `Preview sent to ${preview.previewTo || 'owner'} at ${new Date(preview.sentAt).toLocaleTimeString()}`,
      reviewCount: preview.reviewCount,
    };
  }

  const discarded = discardedRecordForShow(sentShows, showId);
  if (discarded) {
    return discarded.sendUnverified
      ? { state: 'not-sent', detail: 'Marked not sent, but Resend had already lost the draft, so it may have gone out' }
      : { state: 'not-sent', detail: 'Not sent (owner chose to skip this email)' };
  }

  const earlier = previewKeysForShow(sentShows, showId).sort(byPreviewDate);
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

module.exports = { showBroadcastStatus, isDiscardedShow, discardedRecordForShow };
