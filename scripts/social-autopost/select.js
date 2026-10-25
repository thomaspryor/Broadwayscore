/**
 * Decide which social posts are due. Pure functions over loaded data, so the
 * rules are unit-tested without network or a browser (social-autopost.test.mjs).
 */

const { evaluateScoreConfidence } = require('../lib/score-confidence-gate');
const { hasEnoughReviews } = require('../lib/min-reviews');
const { priorRunClassifier } = require('../lib/prior-run-sibling');
const C = require('./config');

const DAY_MS = 864e5;

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

function curtainTime(show, hour, tz) {
  return zonedTime(String(show.openingDate).slice(0, 10), hour, tz).getTime();
}

function isEligibleShow(show) {
  if (!show || !show.id || !show.openingDate) return false;
  if (!C.ELIGIBLE_CATEGORIES.includes(show.category)) return false;
  if (show.type && C.SKIP_TYPES.has(String(show.type).toLowerCase())) return false;
  if (show.provisional) return false;
  if (['cancelled', 'canceled', 'postponed'].includes(show.status)) return false;
  return true;
}

function isMajorVenue(show) {
  const pats = C.MAJOR_VENUES[show.category];
  if (!pats) return true; // Broadway and West End: every opening
  return pats.some(re => re.test(show.venue || ''));
}

function postedKeys(history) {
  return new Set((history && history.posts || []).filter(p => p.type && p.showId).map(p => `${p.type}:${p.showId}`));
}

/**
 * Opening posts due now. A post is queued in Buffer up to OPENING_SCHEDULE_AHEAD_HOURS
 * before noon local on opening day, and given up on after OPENING_LATEST_LOCAL_HOUR.
 */
function findOpeningEvents({ shows, history, now }) {
  const done = postedKeys(history);
  const out = [];
  for (const show of shows) {
    if (!isEligibleShow(show) || !isMajorVenue(show)) continue;
    if (done.has(`opening:${show.id}`)) continue;
    const tz = C.MARKETS[show.category].tz;
    const ymd = String(show.openingDate).slice(0, 10);
    const due = zonedTime(ymd, C.OPENING_POST_LOCAL_HOUR, tz);
    const latest = zonedTime(ymd, C.OPENING_LATEST_LOCAL_HOUR, tz);
    if (now < due.getTime() - C.OPENING_SCHEDULE_AHEAD_HOURS * 36e5 || now > latest.getTime()) continue;
    out.push({ type: 'opening', show, dueAt: new Date(Math.max(due.getTime(), now + 10 * 60e3)) });
  }
  return out;
}

/** Next allowed posting instant for a score post (inside the local daytime window). */
function nextScoreSlot(now, tz) {
  const lp = localParts(new Date(now), tz);
  if (lp.hour >= C.SCORE_POST_WINDOW.start && lp.hour < C.SCORE_POST_WINDOW.end) return new Date(now + 10 * 60e3);
  const ymd = lp.hour >= C.SCORE_POST_WINDOW.end ? addDaysYmd(lp.ymd, 1) : lp.ymd;
  return zonedTime(ymd, C.SCORE_POST_WINDOW.start, tz);
}

/**
 * Score posts due now.
 * slim: { [showId]: { cs, rc } } from public/data/shows/{id}.json (the site's own numbers).
 */
function findScoreEvents({ shows, history, now, reviewsByShow, slim, getOutletTier }) {
  const done = postedKeys(history);
  const out = [];
  for (const show of shows) {
    if (!isEligibleShow(show)) continue;
    if (done.has(`score:${show.id}`)) continue;
    const tz = C.MARKETS[show.category].tz;
    // No score post before curtain on opening night: reviews are not out yet, and
    // the "opens tonight" post promises the score comes after.
    const curtain = curtainTime(show, C.SCORE_EARLIEST_LOCAL_HOUR, tz);
    if (!(curtain <= now && now - curtain <= C.SCORE_LOOKBACK_DAYS * DAY_MS)) continue;
    const pub = slim[show.id];
    if (!pub || !Number.isFinite(pub.cs) || !pub.rc) continue;
    const showReviews = reviewsByShow[show.id] || [];
    // BRO-4954: a transfer or return carries its earlier run's reviews; require
    // reviews of THIS run, exactly as the opening-night email does.
    let newReviewCount = null;
    if (Array.isArray(show.priorRuns) && show.priorRuns.length) {
      const runs = priorRunClassifier(show, shows);
      if (runs.windows.length) newReviewCount = showReviews.filter(r => Number.isFinite(r.assignedScore)).filter(runs.isCurrent).length;
    }
    const gate = evaluateScoreConfidence({ showReviews, category: show.category, getOutletTier, newReviewCount });
    if (!gate.ok) continue;
    const extra = C.SCORE_FLOORS[show.category];
    if (extra && (gate.counts.total < (extra.total || 0) || gate.counts.t1 < (extra.t1 || 0))) continue;
    if (!hasEnoughReviews(pub.rc, show.category, gate.counts.t1 + gate.counts.t2)) continue;
    out.push({ type: 'score', show, gate, dueAt: nextScoreSlot(now, tz) });
  }
  return out;
}

/**
 * Space posts at least STAGGER_MINUTES apart, counting posts already queued in
 * Buffer (history entries whose dueAt is still ahead). Mutates and returns events.
 */
function staggerEvents(events, history, now) {
  const gap = C.STAGGER_MINUTES * 60e3;
  const taken = (history && history.posts || [])
    .map(p => Date.parse(p.dueAt || ''))
    .filter(t => Number.isFinite(t) && t > now - gap);
  events.sort((a, b) => a.dueAt - b.dueAt || (a.type === 'opening' ? -1 : 1));
  for (const ev of events) {
    let t = ev.dueAt.getTime();
    if (ev.type === 'opening') {
      // Same-day openings go out 90 minutes apart from noon local, never after
      // OPENING_LATEST_LOCAL_HOUR (then they share the last slot).
      const latest = zonedTime(String(ev.show.openingDate).slice(0, 10), C.OPENING_LATEST_LOCAL_HOUR, C.MARKETS[ev.show.category].tz).getTime();
      while (taken.some(x => Math.abs(x - t) < gap) && t + gap <= latest) t += gap;
      ev.dueAt = new Date(t);
    } else {
      const tz = C.MARKETS[ev.show.category].tz;
      const inWindow = x => { const h = localParts(new Date(x), tz).hour; return h >= C.SCORE_POST_WINDOW.start && h < C.SCORE_POST_WINDOW.end; };
      for (let guard = 0; guard < 50 && (!inWindow(t) || taken.some(x => Math.abs(x - t) < gap)); guard++) {
        t = inWindow(t) ? t + gap : nextScoreSlot(t, tz).getTime();
      }
      ev.dueAt = new Date(t);
    }
    taken.push(t);
  }
  return events;
}

/**
 * First live run (no opening/score entry in history yet): score posts for shows
 * that opened more than FIRST_RUN_FRESH_DAYS ago are recorded as skipped instead
 * of posted, so switching the system on does not flood every channel with weeks
 * of backlog. Returns { post, skip }.
 */
function splitBacklog(events, history, now) {
  const started = (history && history.posts || []).some(p => p.type === 'opening' || p.type === 'score');
  if (started) return { post: events, skip: [] };
  const cutoff = now - C.FIRST_RUN_FRESH_DAYS * DAY_MS;
  const post = [], skip = [];
  for (const ev of events) {
    const opened = Date.parse(`${String(ev.show.openingDate).slice(0, 10)}T00:00:00Z`);
    (ev.type === 'score' && opened < cutoff ? skip : post).push(ev);
  }
  return { post, skip };
}

module.exports = { splitBacklog, findOpeningEvents, findScoreEvents, staggerEvents, nextScoreSlot, zonedTime, localParts, isMajorVenue, isEligibleShow };
