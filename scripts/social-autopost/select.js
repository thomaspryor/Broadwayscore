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
 * Score posts whose slot is reached (or within the creation lead) and whose score is settled.
 * slim: { [showId]: { cs, rc } } from public/data/shows/{id}.json (the site's own numbers).
 */
function findScoreEvents({ shows, ledger, now, reviewsByShow, slim, getOutletTier }) {
  const done = doneKeys(ledger);
  const out = [];
  for (const show of shows) {
    if (!isEligibleShow(show)) continue;
    if (done.has(`score:${show.id}`)) continue;
    const slot = morningAfter(show);
    if (now < slot - C.CREATE_LEAD_MINUTES * MIN_MS) continue; // not yet
    if (now - slot > C.SCORE_LOOKBACK_DAYS * DAY_MS) continue; // too old
    const pub = slim[show.id];
    if (!pub || !Number.isFinite(pub.cs) || !pub.rc) continue;
    const showReviews = reviewsByShow[show.id] || [];
    const gate = evaluateScoreConfidence({
      showReviews, category: show.category, getOutletTier,
      newReviewCount: newReviewCountFor(show, shows, showReviews),
      floors: C.SCORE_FLOORS[show.category] || null,
    });
    if (!gate.ok) continue;
    if (!hasEnoughReviews(pub.rc, show.category, gate.counts.t1 + gate.counts.t2)) continue;
    const tz = C.MARKETS[show.category].tz;
    out.push({ type: 'score', show, gate, dueAt: new Date(nextWindowSlot(Math.max(slot, now + 10 * MIN_MS), tz)) });
  }
  return out;
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
      t = inWindow(t, tz) ? t + gap : nextWindowSlot(t, tz);
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

module.exports = { findScoreEvents, scheduleEvents, splitBacklog, morningAfter, nextWindowSlot, zonedTime, localParts, isEligibleShow, newReviewCountFor };
