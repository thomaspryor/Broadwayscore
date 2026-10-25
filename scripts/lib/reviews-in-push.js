/**
 * Pure decisions for the "The reviews are in" mobile push dispatched from
 * opening-night-broadcast.yml (BRO-6219). The app repo's sender does the
 * selecting and sending; this decides WHICH shows get dispatched and when the
 * web-side "pushed" marker may be written.
 */

const DAY_MS = 86_400_000;
const PUSH_CATEGORIES = new Set(['broadway', 'west-end']);
/** A show that opened longer ago than this never gets a late "reviews are in". */
const MAX_AGE_DAYS = 4;

/** The run-name the app workflow gives a reviews-in run (send-notifications.yml run-name). */
function runNameFor(showId) {
  return `send-notifications reviews-in ${showId}`;
}

/**
 * Shows to dispatch: ready for broadcast (same review thresholds as the email),
 * Broadway or West End only (Off-Broadway reaches people through their To Watch
 * list in the app), opened recently, and not already marked pushed.
 * @param {{readyIds: string[], shows: Array<object>, sent: Record<string, object>, now?: number}} input
 */
function pushCandidates({ readyIds, shows, sent, now = Date.now() }) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const out = [];
  for (const id of readyIds) {
    const s = byId.get(id);
    if (!s) continue;
    const category = s.category || 'broadway';
    if (!PUSH_CATEGORIES.has(category)) continue;
    if (sent && sent[`push:${id}`]) continue;
    // First 10 chars: openingDate is a plain date, but a full timestamp must not read as NaN and drop the show.
    const opened = Date.parse(`${String(s.openingDate || '').slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(opened) || now - opened > MAX_AGE_DAYS * DAY_MS) continue;
    out.push({ id, slug: s.slug || s.id, title: s.title, category });
  }
  return out;
}

/** The run we dispatched: matching name, created at or after the dispatch (clock-skew slack). */
function findDispatchedRun(runs, showId, dispatchedAtMs, slackMs = 60_000) {
  const name = runNameFor(showId);
  const hits = runs
    .filter(r => (r.displayTitle || r.name) === name)
    .filter(r => Date.parse(r.createdAt) >= dispatchedAtMs - slackMs)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return hits[0] || null;
}

/** 'pending' until the run finishes; 'sent' only on success (the app exits non-zero when no ticket was accepted). */
function runOutcome(run) {
  if (!run || run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'sent' : 'failed';
}

module.exports = { pushCandidates, findDispatchedRun, runOutcome, runNameFor, MAX_AGE_DAYS };
