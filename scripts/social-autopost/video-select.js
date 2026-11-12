/**
 * Which videos are due (BRO-7414). Pure: no network, no files. The video lane reuses the text lane's
 * decisions instead of keeping its own rule: select.js scoreDecision (eligibility, settled score, done keys) and
 * londonCompareDecision. Only the "done" set differs: it comes from the video ledger, so a show whose text card went out
 * still owes its video. Importance is BRO-7413's socialNotable (notable.js), the same predicate the text lane uses.
 */
const C = require('./config');
const S = require('./select');
const { socialNotable } = require('./notable');

const DAY_MS = 864e5;
const NETWORKS = Object.keys(C.VIDEO.channels);

/** Importance gate: BRO-7413's socialNotable (Broadway, plus Off-Broadway with 4+ tier-1 critics or 500+ audience), the one predicate both lanes share. */
function videoWorthy(show, { slim } = {}) { return socialNotable(show, slim || undefined); }

const { findLondonRun } = require('../lib/transfer-detection');
// Shows that have a London run at all (score checks aside), found once per shows list: the per-show London match is a title
// comparison against every show, too slow to repeat for every show on every day of a look-back. londonCompareDecision still decides.
const pairCache = new WeakMap();
function londonCandidates(shows) {
  if (!pairCache.has(shows)) pairCache.set(shows, new Set(shows.filter(s => findLondonRun(s, shows, { hasScore: () => true }).london).map(s => s.id)));
  return pairCache.get(shows);
}

const keyOf = ev => `${ev.type}:${ev.show.id}`; // 'score:<id>' (reveal) or 'london-compare:<id>' (compare), the select.js key shapes

/** Entry is finished when every network has a Buffer post or it was abandoned. */
function entryDone(p) {
  return !!p.abandoned || NETWORKS.every(n => p.channels && p.channels[n] && p.channels[n].postId);
}

/** Pure: the done keys the select.js decisions read, from the video ledger. */
function videoDoneKeys(ledger) {
  const keys = new Set();
  for (const p of (ledger && ledger.posts) || []) if (p.showId && entryDone(p)) keys.add(`${p.type}:${p.showId}`);
  return keys;
}

function nyDay(t) { return new Intl.DateTimeFormat('en-CA', { timeZone: C.VIDEO.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); }

/** Networks that already have a video on this New York day (ledger rows with a Buffer post made that day). */
function busyNetworks(ledger, now) {
  const day = nyDay(now), busy = new Set();
  for (const p of (ledger && ledger.posts) || []) for (const [n, c] of Object.entries(p.channels || {})) {
    if (!c || !c.postId) continue;
    // made today OR due today: a video made at 22:41 for 09:00 tomorrow already holds tomorrow's slot
    if (nyDay(Date.parse(c.createdAt || p.createdAt)) === day || (p.dueAt && nyDay(Date.parse(p.dueAt)) === day)) busy.add(n);
  }
  return busy;
}

/** Failed attempts for an event key on this New York day / ever. */
function attempts(ledger, key, now) {
  // one run that fails on both networks is one attempt (failures of a run share `at`); a skip (no audience grade yet) only waits out the day
  const f = ((ledger && ledger.failures) || []).filter(x => x.key === key);
  const runs = list => new Set(list.map(x => x.at)).size;
  return { today: runs(f.filter(x => nyDay(Date.parse(x.at)) === nyDay(now))), total: runs(f.filter(x => x.kind !== 'skip')), skippedToday: f.some(x => x.kind === 'skip' && nyDay(Date.parse(x.at)) === nyDay(now)) };
}

/**
 * Videos made this month (New York time), the number the monthly spend cap counts. One make is one voice and one copy review, so a
 * post counts once however many networks it went to (its channels share createdAt), and a failed attempt counts once per run (shared `at`).
 * Skips (no audience grade yet) stop before the voice and cost nothing.
 */
function makesThisMonth(ledger, now) {
  const month = nyDay(now).slice(0, 7), runs = new Set();
  for (const p of (ledger && ledger.posts) || []) {
    const stamps = Object.values(p.channels || {}).map(c => c && c.createdAt).filter(Boolean);
    for (const t of new Set(stamps.length ? stamps : [p.createdAt])) if (t && nyDay(Date.parse(t)).slice(0, 7) === month) runs.add(`post:${p.type}:${p.showId}:${t}`);
  }
  for (const f of (ledger && ledger.failures) || []) if (f.kind !== 'skip' && f.at && nyDay(Date.parse(f.at)).slice(0, 7) === month) runs.add(`fail:${f.at}`);
  return runs.size;
}

/**
 * Every due video event and why the others are not. events: [{type, fmt, show, london?, slot}], skipped: [{show, why}].
 * compare events sort first (a pair is the richer story), then newest opening first.
 */
function findVideoEvents({ shows, textLedger, videoLedger, now, reviewsByShow, slim, getOutletTier, lookbackDays = C.VIDEO.lookbackDays }) {
  const done = videoDoneKeys(videoLedger);
  const ctx = { done, now, reviewsByShow, slim, getOutletTier, shows };
  const events = [], skipped = [];
  for (const show of shows) {
    if (!S.isEligibleShow(show, { allowOpera: true, allowTouring: true, shows, slim })) continue;
    if (!videoWorthy(show, { slim })) { skipped.push({ show, why: 'not-important' }); continue; }
    const cmp = C.VIDEO.formats.includes('compare') && londonCandidates(shows).has(show.id) ? S.londonCompareDecision(show, { shows, ledger: textLedger, now, slim, done }) : { due: false };
    // both formats can be due for one show: the compare sorts first, and the score video takes the next free day (BRO-7418)
    if (cmp.due) events.push({ type: 'london-compare', fmt: 'compare', show, london: cmp.london, slot: cmp.slot });
    const d = S.scoreDecision(show, ctx, { ignoreAge: true });
    if (!d.due) { if (d.why !== 'done' && d.why !== 'ineligible') skipped.push({ show, why: d.why }); continue; }
    if (now - d.slot > lookbackDays * DAY_MS) { skipped.push({ show, why: 'too-old' }); continue; }
    if (C.VIDEO.formats.includes('reveal')) events.push({ type: 'score', fmt: 'reveal', show, slot: d.slot });
  }
  events.sort((a, b) => (a.fmt === 'compare' ? 0 : 1) - (b.fmt === 'compare' ? 0 : 1) || b.slot - a.slot);
  return { events, skipped };
}

/**
 * The one event to make now and the networks it goes to: at most maxPerNetworkPerDay per network per New York day, and
 * events that failed maxAttemptsPerDay times today (or maxAttemptsTotal ever) wait. null when nothing may post.
 */
function pickToday(events, videoLedger, now, { maxMakes = C.VIDEO.maxMakesPerMonth } = {}) {
  const made = makesThisMonth(videoLedger, now);
  if (made >= maxMakes) return { pick: null, why: `monthly cap reached (${made} of ${maxMakes} videos made this month)` };
  const busy = busyNetworks(videoLedger, now), free = NETWORKS.filter(n => !busy.has(n));
  if (!free.length) return { pick: null, why: 'every network already has a video today' };
  for (const ev of events) {
    const a = attempts(videoLedger, keyOf(ev), now);
    if (a.total >= C.VIDEO.maxAttemptsTotal || a.today >= C.VIDEO.maxAttemptsPerDay || a.skippedToday) continue;
    // a partly posted entry (one network failed earlier) only fills the networks it lacks
    const row = ((videoLedger && videoLedger.posts) || []).find(p => p.type === ev.type && p.showId === ev.show.id && !entryDone(p));
    const targets = free.filter(n => !(row && row.channels && row.channels[n] && row.channels[n].postId));
    if (targets.length) return { pick: { ...ev, targets }, why: null };
  }
  return { pick: null, why: events.length ? 'every due video is waiting after failed attempts' : 'nothing due' };
}

module.exports = { makesThisMonth, videoWorthy, videoDoneKeys, entryDone, busyNetworks, attempts, findVideoEvents, pickToday, keyOf, nyDay, NETWORKS };
