'use strict';
/**
 * "Won't send" for a show with no Resend draft to delete (BRO-3087).
 *
 * discard-stuck-broadcast-drafts.js (BRO-2935) lets the owner drop a draft
 * that sits unsent in Resend. It refuses a show with no live draft, so a show
 * whose draft was never created ('never-drafted') or 404s ('draft-unknown')
 * kept paging broadcast:never-sent with no way to say "leave it". --no-draft
 * stamps such shows discarded instead: classifyBroadcastState() reads
 * 'discarded', shouldRequeueShow() returns false, the missed-broadcast sweep
 * resolves the page. Nothing here calls Resend; the CLI passes in which draft
 * ids a live GET just confirmed gone (404).
 */

const { classifyBroadcastState, classifyShowBroadcastState, isSideKey, keyShowIds } = require('./missed-broadcasts');
const { markDraftDiscarded } = require('./broadcast-state');

/** Every tracker key (side keys excluded) that names this show. */
function recordKeysForShow(sentShows, showId) {
  return Object.keys(sentShows || {}).filter((k) => !isSideKey(k) && keyShowIds(k).includes(showId));
}

/** A show already settled on its own (sent, or recorded "won't send"). */
function isSettled(sentShows, showId) {
  const state = classifyShowBroadcastState(sentShows, showId);
  return state === 'sent' || state === 'discarded';
}

/**
 * Every show that shares a Resend draft with this one (the show itself
 * included). A combo draft can only be discarded with all its shows named.
 * With `skipSettled`, other shows already sent or discarded on their own are
 * left out: --no-draft deletes nothing, so it need not name them, and naming
 * a sent one is refused (BRO-3087 retro-review, BRO-5261).
 */
function draftShowIds(sentShows, showId, { skipSettled = false } = {}) {
  const shows = sentShows || {};
  const draftIds = new Set(recordKeysForShow(shows, showId).map((k) => shows[k] && shows[k].draftId).filter(Boolean));
  const ids = new Set([showId]);
  for (const [k, rec] of Object.entries(shows)) {
    if (isSideKey(k) || !rec || !draftIds.has(rec.draftId)) continue;
    for (const id of keyShowIds(k)) {
      if (skipSettled && id !== showId && isSettled(shows, id)) continue;
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Why --no-draft must refuse, or null. `openingDates` maps show id ->
 * openingDate (data/shows.json); `goneDraftIds` holds drafts a live GET just
 * found 404. Every record naming a show is checked, not only its per-show
 * mirror, since mirrors and combo records can disagree (BRO-4474).
 */
function dismissBlockReason(sentShows, showIds, { openingDates, today, goneDraftIds = new Set() } = {}) {
  if (!showIds || !showIds.length) return 'pass --show=<id>[,<id>...]';
  const shows = sentShows || {};
  const named = new Set(showIds);
  for (const id of showIds) {
    if (!openingDates || !openingDates.has(id)) return `${id} is not a show in data/shows.json`;
    const opened = openingDates.get(id);
    if (!opened || opened > today) return `${id} has not opened yet (openingDate ${opened || 'unknown'}); nothing was missed`;
    if (classifyShowBroadcastState(shows, id) === 'sent') return `${id} was already sent; nothing to dismiss`;
    for (const key of recordKeysForShow(shows, id)) {
      const rec = shows[key];
      if (!rec || rec.discardedAt) continue;
      // A show settled on its own (sent later, or already skipped) does not
      // need naming: stamping this leftover record cannot unsend or resend it.
      const others = keyShowIds(key).filter((s) => !named.has(s) && !isSettled(shows, s));
      if (others.length) return `${key} also covers ${others.join(', ')}; name every show of that broadcast`;
      const state = classifyBroadcastState(rec);
      if (state === 'sent') return `${key} was already sent; nothing to dismiss`;
      if (state === 'draft-stuck' && !goneDraftIds.has(rec.draftId)) {
        return `${key} has a Resend draft waiting (${rec.draftId}); discard it without --no-draft so the draft is deleted too`;
      }
    }
  }
  return null;
}

/**
 * The tracker writes for --no-draft: every undiscarded record naming each
 * show is stamped discarded, and a show with no per-show record gets one,
 * since the send filter and the sweep read the per-show record first.
 * Returns { [key]: newRecord } and does not mutate sentShows.
 */
function planNoDraftDismissal(sentShows, showIds, { nowIso, reason, goneDraftIds = new Set() } = {}) {
  const shows = sentShows || {};
  const out = {};
  for (const id of showIds) {
    for (const key of recordKeysForShow(shows, id)) {
      const rec = shows[key];
      if (!rec || rec.discardedAt) continue;
      // A draft Resend 404s may have been sent and reaped (broadcast-state.js);
      // keep that on the record so the status pages do not say "skipped" as
      // if it certainly never went out (BRO-3087 retro-review, BRO-5261).
      const unverified = classifyBroadcastState(rec) === 'draft-unknown' || (rec.draftId && goneDraftIds.has(rec.draftId));
      out[key] = { ...markDraftDiscarded(rec, { nowIso, reason }), ...(unverified ? { sendUnverified: true } : {}) };
    }
    if (!shows[id] && !out[id]) out[id] = markDraftDiscarded({}, { nowIso, reason });
  }
  return out;
}

/**
 * The one command that records "won't send" for this show in this sweep
 * state, naming every show of a combo draft: --no-draft where there is no
 * Resend draft to delete (never drafted, or it 404s), the default discard
 * (which deletes the waiting draft) otherwise.
 */
function wontSendCommand(sentShows, showId, state) {
  const noDraft = state === 'never-drafted' || state === 'draft-unknown';
  const ids = draftShowIds(sentShows, showId, { skipSettled: noDraft }).join(',');
  return `gh workflow run discard-broadcast-draft.yml -f shows=${ids}${noDraft ? ' -f no_draft=true' : ''} -f dry_run=false`;
}

module.exports = { dismissBlockReason, planNoDraftDismissal, wontSendCommand, draftShowIds, recordKeysForShow };
