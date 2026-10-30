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

/**
 * What the app sender needs to match the "never miss" threshold modes (BRO-6583),
 * read from the mobile feed entry the same job just built (generate-mobile-artifacts.sh
 * runs before the push step). Same fields and gates the app shows:
 *   criticScore / criticLabel  only when the feed marks the score displayable (cr.q === 1);
 *                              an unqualified score never counts toward Gold or 75+
 *   audienceGrade              the letter (ag.g)
 *   showType                   'musical' | 'play' | ... (ty)
 * Empty strings mean "unknown" and the dispatch marks the facts as final
 * (facts=dispatch), so the app does not fill the gaps from an older live feed;
 * a mode it cannot confirm does not match (it never guesses).
 * @param {object|undefined} feedShow one entry of public/data/mobile-shows.json
 */
function feedFacts(feedShow) {
  const cr = feedShow && feedShow.cr;
  const shown = cr && cr.q === 1 && typeof cr.s === 'number' && Number.isFinite(cr.s);
  const ag = feedShow && feedShow.ag && typeof feedShow.ag.g === 'string' ? feedShow.ag.g : '';
  return {
    criticScore: shown ? String(Math.round(cr.s)) : '',
    criticLabel: shown && typeof cr.l === 'string' ? cr.l : '',
    audienceGrade: ag,
    showType: feedShow && typeof feedShow.ty === 'string' ? feedShow.ty : '',
  };
}

/** The committed/built feed is trusted for facts only when it was built this recently (a retry can read an old committed file). */
const FEED_MAX_AGE_MS = 3 * 60 * 60 * 1000;
function feedIsFresh(ts, now = Date.now()) {
  const t = Date.parse(String(ts || ''));
  return !Number.isNaN(t) && now - t >= -60_000 && now - t <= FEED_MAX_AGE_MS;
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

module.exports = { pushCandidates, feedFacts, feedIsFresh, findDispatchedRun, runOutcome, runNameFor, MAX_AGE_DAYS };
