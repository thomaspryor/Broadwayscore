/**
 * Decide which score posts are due. Pure functions over loaded data, so the
 * rules are unit-tested without network or a browser (social-autopost.test.mjs).
 *
 * A show's post goes out at SCORE_POST_LOCAL_HOUR local the morning after opening
 * night, or, if the score settles later, at the next daytime slot. It is created
 * in Buffer only when it is due within CREATE_LEAD_MINUTES, so the numbers on it
 * are read at most about an hour before followers see them.
 */

const { evaluateScoreConfidence } = require('../lib/score-confidence-gate');
const { hasEnoughReviews } = require('../lib/min-reviews');
const { priorRunClassifier } = require('../lib/prior-run-sibling');
const { findLondonRun } = require('../lib/transfer-detection');
const C = require('./config');

const DAY_MS = 864e5;
const MIN_MS = 60e3;

/** Wall-clock parts of `date` in `tz`. */
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}

/** UTC Date for local `ymd` at `hour`:00 in `tz` (DST-safe: corrects by the zone's offset at that instant). */
function zonedTime(ymd, hour, tz) {
  const guess = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`);
  for (let i = 0; i < 2; i++) {
    const lp = localParts(guess, tz);
    const asUtc = Date.UTC(+lp.ymd.slice(0, 4), +lp.ymd.slice(5, 7) - 1, +lp.ymd.slice(8, 10), lp.hour, lp.minute);
    const want = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), hour, 0);
    guess.setTime(guess.getTime() + (want - asUtc));
  }
  return guess;
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isEligibleShow(show) {
  if (!show || !show.id || !show.openingDate) return false;
  if (!C.ELIGIBLE_CATEGORIES.includes(show.category)) return false;
  if (show.type && C.SKIP_TYPES.has(String(show.type).toLowerCase())) return false;
  if (show.provisional) return false;
  if (['cancelled', 'canceled', 'postponed'].includes(show.status)) return false;
  return true;
}

/** The morning-after slot: SCORE_POST_LOCAL_HOUR on the day after opening, local time. */
function morningAfter(show) {
  const tz = C.MARKETS[show.category].tz;
  return zonedTime(addDaysYmd(String(show.openingDate).slice(0, 10), 1), C.SCORE_POST_LOCAL_HOUR, tz).getTime();
}

function inWindow(t, tz) {
  const h = localParts(new Date(t), tz).hour;
  return h >= C.SCORE_POST_WINDOW.start && h < C.SCORE_POST_WINDOW.end;
}

/** First instant >= t inside the daytime posting window. */
function nextWindowSlot(t, tz) {
  if (inWindow(t, tz)) return t;
  const lp = localParts(new Date(t), tz);
  const ymd = lp.hour >= C.SCORE_POST_WINDOW.end ? addDaysYmd(lp.ymd, 1) : lp.ymd;
  return zonedTime(ymd, C.SCORE_POST_WINDOW.start, tz).getTime();
}

function doneKeys(ledger) {
  return new Set((ledger && ledger.posts || []).filter(p => p.showId).map(p => `${p.type || 'score'}:${p.showId}`));
}

/** Reviews of this run for a returning production (BRO-4954); null when there is no prior run. */
function newReviewCountFor(show, shows, showReviews) {
  if (!Array.isArray(show.priorRuns) || !show.priorRuns.length) return null;
  const runs = priorRunClassifier(show, shows);
  if (!runs.windows.length) return null;
  return showReviews.filter(r => Number.isFinite(r.assignedScore)).filter(runs.isCurrent).length;
}

/**
 * Why one show's score post is or is not due now. {due: true, slot, gate} or
 * {due: false, why, slot, gate?}; why is one of ineligible, done, not-yet,
 * too-old, no-score, not-confident, too-few-reviews. The checks run in this
 * order, and findScoreEvents posts exactly the shows this calls due.
 * ignoreAge skips the too-old check, so the weekly email can say what was
 * still missing when a show aged out (scripts/lib/social-report.js).
 */
function scoreDecision(show, { done, now, reviewsByShow, slim, getOutletTier, shows }, { ignoreAge = false } = {}) {
  if (!isEligibleShow(show)) return { due: false, why: 'ineligible' };
  if (done.has(`score:${show.id}`)) return { due: false, why: 'done' };
  const slot = morningAfter(show);
  if (now < slot - C.CREATE_LEAD_MINUTES * MIN_MS) return { due: false, why: 'not-yet', slot };
  if (!ignoreAge && now - slot > C.SCORE_LOOKBACK_DAYS * DAY_MS) return { due: false, why: 'too-old', slot };
  const pub = slim[show.id];
  if (!pub || !Number.isFinite(pub.cs) || !pub.rc) return { due: false, why: 'no-score', slot };
  const showReviews = reviewsByShow[show.id] || [];
  const gate = evaluateScoreConfidence({
    showReviews, category: show.category, getOutletTier,
    newReviewCount: newReviewCountFor(show, shows, showReviews),
    floors: C.SCORE_FLOORS[show.category] || null,
  });
  if (!gate.ok) return { due: false, why: 'not-confident', slot, gate };
  if (!hasEnoughReviews(pub.rc, show.category, gate.counts.t1 + gate.counts.t2)) return { due: false, why: 'too-few-reviews', slot, gate };
  return { due: true, slot, gate };
}

/**
 * Score posts whose slot is reached (or within the creation lead) and whose score is settled.
 * slim: { [showId]: { cs, rc } } from public/data/shows/{id}.json (the site's own numbers).
 */
function findScoreEvents({ shows, ledger, now, reviewsByShow, slim, getOutletTier }) {
  const ctx = { done: doneKeys(ledger), now, reviewsByShow, slim, getOutletTier, shows };
  const out = [];
  for (const show of shows) {
    const d = scoreDecision(show, ctx);
    if (!d.due) continue;
    const tz = C.MARKETS[show.category].tz;
    out.push({ type: 'score', show, gate: d.gate, dueAt: new Date(nextWindowSlot(Math.max(d.slot, now + 10 * MIN_MS), tz)) });
  }
  return out;
}

/** True when the site shows a Critic Score for this show (the number a post would state). */
function hasSiteScore(slim, id) {
  const pub = slim[id];
  return !!pub && Number.isFinite(pub.cs) && !!pub.rc;
}

/** The ledger entry of a score post that actually went to Buffer (not a go-live backlog skip), or null. */
function sentScoreEntry(ledger, showId) {
  return (ledger && ledger.posts || []).find(p => (p.type || 'score') === 'score' && p.showId === showId && !p.skipped
    && Object.values(p.channels || {}).some(c => c && c.postId)) || null;
}

/** True when a brief compare post already covers this pair of shows (any time). */
function briefCoversPair(ledger, ids) {
  const key = [...ids].sort().join('+');
  return (ledger && ledger.posts || []).some(p => p.type === 'brief' && p.pair === key);
}

/**
 * Why one show's London comparison post (BRO-6373) is or is not due now. {due: true, london, slot}
 * or {due: false, why, ...}; why is one of ineligible, done, no-london-run (reason says why),
 * brief-exists, no-score-post, not-yet, too-old. The post goes out at SCORE_POST_LOCAL_HOUR on the
 * day after the show's score post went out, so the score post always comes first.
 */
function londonCompareDecision(show, { shows, ledger, now, slim, done }) {
  if (!isEligibleShow(show)) return { due: false, why: 'ineligible' };
  if (done.has(`london-compare:${show.id}`)) return { due: false, why: 'done' };
  const { london, reason } = findLondonRun(show, shows, { hasScore: id => hasSiteScore(slim, id) });
  if (!london) return { due: false, why: 'no-london-run', reason };
  if (briefCoversPair(ledger, [show.id, london.id])) return { due: false, why: 'brief-exists', london };
  const score = sentScoreEntry(ledger, show.id);
  if (!score) return { due: false, why: 'no-score-post', london };
  const tz = C.MARKETS[show.category].tz;
  const slot = zonedTime(addDaysYmd(localParts(new Date(score.dueAt), tz).ymd, 1), C.SCORE_POST_LOCAL_HOUR, tz).getTime();
  if (now < slot - C.CREATE_LEAD_MINUTES * MIN_MS) return { due: false, why: 'not-yet', london, slot };
  if (now - slot > C.LONDON_COMPARE_LOOKBACK_DAYS * DAY_MS) return { due: false, why: 'too-old', london, slot };
  return { due: true, london, slot };
}

/**
 * London comparison posts whose slot is reached (or within the creation lead): a Broadway or
 * Off-Broadway show whose score post went out and that has exactly one London run
 * (transfer-detection.js findLondonRun). The post carries the Phase A compare card.
 */
function findLondonCompareEvents({ shows, ledger, now, slim }) {
  const done = doneKeys(ledger);
  const out = [];
  for (const show of shows) {
    const d = londonCompareDecision(show, { shows, ledger, now, slim, done });
    if (d.due) out.push({ type: 'london-compare', show, london: d.london, slot: d.slot, dueAt: new Date(d.slot) });
  }
  return out;
}

/**
 * Dry-run look back: every eligible show that opened in the last `days` days and has a London
 * run, with what the live rules would do about it. wouldFire: its score post went out, it is not
 * done and no brief covers the pair. Shows without a sent score post are still listed, so a
 * go-live backlog skip is visible.
 */
function londonCompareLookback({ shows, ledger, now, slim, days }) {
  const done = doneKeys(ledger);
  const out = [];
  for (const show of shows) {
    if (!isEligibleShow(show)) continue;
    const opened = Date.parse(`${String(show.openingDate).slice(0, 10)}T00:00:00Z`);
    if (!(now - opened <= days * DAY_MS && opened <= now)) continue;
    const { london } = findLondonRun(show, shows, { hasScore: id => hasSiteScore(slim, id) });
    if (!london) continue;
    const score = sentScoreEntry(ledger, show.id);
    const scoreRow = (ledger.posts || []).find(p => (p.type || 'score') === 'score' && p.showId === show.id);
    out.push({
      show, london,
      scorePost: score ? 'sent' : scoreRow && scoreRow.skipped ? `skipped (${scoreRow.skipped})` : 'none',
      brief: briefCoversPair(ledger, [show.id, london.id]), done: done.has(`london-compare:${show.id}`),
      wouldFire: !!score && !done.has(`london-compare:${show.id}`) && !briefCoversPair(ledger, [show.id, london.id]),
    });
  }
  return out.sort((a, b) => String(b.show.openingDate).localeCompare(String(a.show.openingDate)));
}

/**
 * Space posts STAGGER_MINUTES apart (counting posts already scheduled in the
 * ledger), keep each in the daytime window, and return only the ones due within
 * the creation lead; the rest are picked up by a later run.
 */
function scheduleEvents(events, ledger, now) {
  const gap = C.STAGGER_MINUTES * MIN_MS;
  const taken = (ledger && ledger.posts || []).map(p => Date.parse(p.dueAt || '')).filter(t => Number.isFinite(t) && t > now - gap);
  events.sort((a, b) => a.dueAt - b.dueAt || a.show.id.localeCompare(b.show.id));
  const ready = [];
  for (const ev of events) {
    const tz = C.MARKETS[ev.show.category].tz;
    let t = ev.dueAt.getTime();
    for (let guard = 0; guard < 50 && (!inWindow(t, tz) || taken.some(x => Math.abs(x - t) < gap)); guard++) {
      // Move past the post it clashes with (not t + gap): a late post due now+10min would
      // otherwise land a full gap after now on every run and never come within the lead.
      const clash = taken.filter(x => Math.abs(x - t) < gap);
      t = !inWindow(t, tz) ? nextWindowSlot(t, tz) : Math.max(Math.max(...clash) + gap, now + 10 * MIN_MS);
    }
    taken.push(t);
    ev.dueAt = new Date(t);
    if (t - now <= C.CREATE_LEAD_MINUTES * MIN_MS) ready.push(ev);
  }
  return ready;
}

/**
 * First live run (nothing in the ledger yet): shows that opened more than
 * FIRST_RUN_FRESH_DAYS ago are recorded as skipped instead of posted, so switching
 * the system on does not flood every network with weeks of backlog.
 */
function splitBacklog(events, ledger, now) {
  if ((ledger && ledger.posts || []).length) return { post: events, skip: [] };
  const cutoff = now - C.FIRST_RUN_FRESH_DAYS * DAY_MS;
  const post = [], skip = [];
  for (const ev of events) (morningAfter(ev.show) < cutoff ? skip : post).push(ev);
  return { post, skip };
}

module.exports = { findLondonCompareEvents, londonCompareDecision, londonCompareLookback, hasSiteScore, sentScoreEntry, briefCoversPair, findScoreEvents, scoreDecision, doneKeys, scheduleEvents, splitBacklog, morningAfter, nextWindowSlot, inWindow, zonedTime, localParts, isEligibleShow, newReviewCountFor };
