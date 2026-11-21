'use strict';
/**
 * review-url-dead.js (BRO-7841): an outlet pulled a published review, so its url now 404s.
 * The review record keeps its text and score; only the outbound LINK is withheld while the
 * page is gone. Reversible: clear urlDead (or the outlet republishes at the same or a new url).
 *
 * Record fields: urlDead:true, urlDeadAt:ISO, urlDeadUrl:<the url that 404ed>, urlDeadStatus:404|410.
 * The marker applies only while record.url still equals urlDeadUrl, so a url repair at a new
 * address restores the link with no extra step.
 */

const DEAD_STATUSES = new Set([404, 410]);
const RECHECK_WINDOW_HOURS = 72;

/** True when the rebuild must publish this review without its link. */
function urlDeadActive(rec) {
  if (!rec || rec.urlDead !== true) return false;
  if (!rec.url) return false;
  return !rec.urlDeadUrl || rec.urlDeadUrl === rec.url;
}

/** The url the rebuild should publish for a record (null when withheld). */
function publishedUrl(rec, fallbackUrl) {
  const url = (rec && rec.url) || fallbackUrl || null;
  if (rec && urlDeadActive(rec)) return null;
  return url;
}

/** Only an explicit gone status counts. 403/429/5xx/timeouts are never evidence. */
function isDeadStatus(status) {
  return DEAD_STATUSES.has(Number(status));
}

/** Published within the window ending at `now`. Date-only values count to the end of that day. */
function withinRecheckWindow(publishDate, now = Date.now(), hours = RECHECK_WINDOW_HOURS) {
  if (!publishDate) return false;
  const s = String(publishDate);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59Z` : s);
  if (!Number.isFinite(t)) return false;
  return t <= now + 36 * 3600e3 && now - t <= hours * 3600e3;
}

/** Decide what to do with one record given two probe statuses (null = request failed). */
function decideRecheck(rec, statuses) {
  if (!rec || !rec.url) return { action: 'skip', reason: 'no-url' };
  const gone = statuses.length >= 2 && statuses.every(isDeadStatus);
  if (urlDeadActive(rec)) {
    if (statuses.length && statuses.every((s) => s != null && s >= 200 && s < 300)) return { action: 'restore', reason: `live again (${statuses.join(',')})` };
    return { action: 'keep', reason: 'still withheld' };
  }
  if (gone) return { action: 'mark', status: Number(statuses[0]) };
  return { action: 'ok', reason: statuses.join(',') || 'no-probe' };
}

/** Apply a mark/restore to a record in place. */
function applyDecision(rec, decision, nowIso = new Date().toISOString()) {
  if (decision.action === 'mark') {
    rec.urlDead = true; rec.urlDeadAt = nowIso; rec.urlDeadUrl = rec.url; rec.urlDeadStatus = decision.status;
    return true;
  }
  if (decision.action === 'restore') {
    // urlDead:false, not a delete: the push-review-texts merge puts back any protected field that is empty locally
    // but set in HEAD, which would flip a restored link back to withheld (review of BRO-7841). The other urlDead* fields
    // stay as the history of the last outage; urlDeadActive() only reads urlDead === true.
    rec.urlDead = false;
    rec.urlRestoredAt = nowIso;
    return true;
  }
  return false;
}

module.exports = { urlDeadActive, publishedUrl, isDeadStatus, withinRecheckWindow, decideRecheck, applyDecision, RECHECK_WINDOW_HOURS };
