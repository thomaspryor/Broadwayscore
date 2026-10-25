'use strict';
// BRO-5861: opening-night-poller.yml polls shows one after another with no
// overall cap. Run 39632362408 polled 32 shows for 1h57m, so the 145-min job
// timeout killed the rebuild step (cancelled -> "crashed" -> page). The loop
// now has a wall-clock budget so collect/score/rebuild always keep their time.

// Rotate the show list so a budget cut does not starve the same tail every run.
// The first `keep` shows (newest openers) stay in front, never rotated.
function rotateShows(shows, seed, keep = 0) {
  const all = shows.filter(Boolean);
  const k = Math.max(0, Math.min(Number(keep) || 0, all.length));
  const head = all.slice(0, k);
  const list = all.slice(k);
  if (list.length === 0) return head;
  const n = ((Number(seed) || 0) % list.length + list.length) % list.length;
  return head.concat(list.slice(n), list.slice(0, n));
}

// Seconds the next show may use: the per-show cap, clamped to what is left in
// the loop budget. 0 means stop (not enough left for a useful poll). The last
// show is clamped to `remaining`, so the loop overruns only by the few seconds
// of per-show bookkeeping after the poller exits.
function showTimeoutSec(remainingSec, capSec = 600, minUsefulSec = 240) {
  if (!(remainingSec >= minUsefulSec)) return 0;
  return Math.min(capSec, Math.floor(remainingSec));
}

// Billy Crystal 860 (2026-10-21): the poller sorted by openingDate desc and
// compared openingDate as UTC midnight, so at 9pm ET four shows opening the
// NEXT day sorted ahead of the night's only Broadway opener, and five Off-
// Broadway shows took 28 min before it. It was polled once, at 01:29Z, half an
// hour before the 02:00Z embargo lift, and not again until the next run.
//
// Order: tier 0 = in its press-night window (opening-night-windows.js
// computeWindow: opening day 17:00 local -> next day 23:59 local), tier 1 =
// local opening date today/yesterday but outside the window, tier 2 = older
// openers, tier 3 = local opening date still in the future, tier 4 = no date
// (stuck-preview backstop). Main stage (broadway, west-end) before Off within a
// tier, then newest first; stable otherwise.
//
// `hot` = main-stage shows within HOT_SPAN_HOURS of their window opening
// (17:00 -> 01:00 local, when embargoes lift; max 3): the loop re-polls them
// every HOT_REPOLL_SEC so an embargo lift is seen within minutes, not next run.
// Kept short on purpose: re-polls and the early publish break both take time
// from the tail, so they must not run through the whole next day.
// `front` = how many shows lead the order before the long tail (tiers 0-1).
// `mainFrontEnd` = index just past the last main-stage row in tiers 0-1 (an
// index, not a count: a tier-1 main-stage show sorts after tier-0 Off shows).
// See shouldBreakEarly for why it exists.
const { computeWindow } = require('./opening-night-windows');
const { localDateString, tzForMarket } = require('./local-date');

const MAIN_STAGE = new Set(['broadway', 'west-end']);
const MAX_HOT = 3;
const HOT_SPAN_HOURS = 8;

function pollTier(show, now) {
  const od = typeof show.openingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(show.openingDate.slice(0, 10))
    ? show.openingDate.slice(0, 10) : null;
  if (!od) return 4;
  const tz = tzForMarket(show.category || 'broadway') || 'America/New_York';
  const today = localDateString(now, tz);
  if (od > today) return 3;
  const w = computeWindow({ ...show, openingDate: od, category: show.category || 'broadway' }, { now });
  if (w && w.windowStart <= now && now <= w.windowEnd) return 0;
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (od >= y.toISOString().slice(0, 10)) return 1;
  return 2;
}

function isHot(show, now) {
  if (!MAIN_STAGE.has(show.category || 'broadway')) return false;
  const od = typeof show.openingDate === 'string' ? show.openingDate.slice(0, 10) : null;
  if (!od) return false;
  const w = computeWindow({ ...show, openingDate: od, category: show.category || 'broadway' }, { now });
  return Boolean(w) && w.windowStart <= now && now.getTime() <= w.windowStart.getTime() + HOT_SPAN_HOURS * 3600 * 1000;
}

function orderPollShows(shows, now = new Date()) {
  const rows = (shows || []).filter((s) => s && s.id).map((s, i) => ({
    s, i,
    tier: pollTier(s, now),
    main: MAIN_STAGE.has(s.category || 'broadway') ? 0 : 1,
    od: typeof s.openingDate === 'string' ? s.openingDate.slice(0, 10) : '',
  }));
  rows.sort((a, b) => a.tier - b.tier || a.main - b.main || (a.od < b.od ? 1 : a.od > b.od ? -1 : 0) || a.i - b.i);
  const order = rows.map((r) => r.s.id);
  const hot = rows.filter((r) => r.tier === 0 && isHot(r.s, now)).slice(0, MAX_HOT).map((r) => r.s.id);
  const front = rows.filter((r) => r.tier <= 1).length;
  let mainFrontEnd = 0;
  rows.forEach((r, idx) => { if (r.tier <= 1 && r.main === 0) mainFrontEnd = idx + 1; });
  return { order, hot, front, mainFrontEnd };
}

// BRO-6033 (Imaginary Invalid, 2026-10-22): the hot show was polled first and
// had 18 new reviews at 02:36Z, but the loop only ended early after all 9 front
// shows (7 Off-Broadway / off-West End) were polled, so publish waited until
// 02:59Z. When a hot show still on its FIRST wave (isFirstWave at loop start)
// gains at least minNew new files, end once the main-stage front is done.
// hotNewCount = new files across all hot shows (the old rule);
// firstWaveNewCount = new files of first-wave hot shows only, so one show's
// later wave cannot trigger the shortcut for another. Any later run keeps the
// full-front rule, so a deferred Off opener waits one run, not the whole night.
function shouldBreakEarly({ polled, total, front, mainFrontEnd, hotNewCount, firstWaveNewCount = 0, minNew = 3 }) {
  if (!(hotNewCount > 0) || !(polled < total)) return false;
  if (polled >= front) return true;
  return firstWaveNewCount >= Math.max(1, minNew) && polled >= mainFrontEnd;
}

// True while fewer than minNew of the show's TRACKED review files were first
// seen inside its current press-night window, i.e. no earlier run has
// committed tonight's wave yet (one early stub does not count as the wave).
// Pre-window files (previews, an earlier production) never count.
function isFirstWave(show, files, now = new Date(), minNew = 3) {
  const od = show && typeof show.openingDate === 'string' ? show.openingDate.slice(0, 10) : null;
  if (!od) return false;
  const w = computeWindow({ ...show, openingDate: od, category: show.category || 'broadway' }, { now });
  if (!w) return false;
  const tonight = (files || []).filter((f) => {
    const t = Date.parse(f && f.firstSeenAt);
    return Number.isFinite(t) && t >= w.windowStart.getTime();
  }).length;
  return tonight < Math.max(1, minNew);
}

module.exports = { rotateShows, showTimeoutSec, orderPollShows, pollTier, isHot, shouldBreakEarly, isFirstWave, HOT_SPAN_HOURS };

if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'rotate') console.log(rotateShows(String(a || '').split(','), b, c).join(','));
  else if (cmd === 'timeout') console.log(showTimeoutSec(Number(a), Number(b) || 600));
  else if (cmd === 'first-wave') {
    // first-wave <showId> <showsJson> <reviewTextsDir> [minNew]: prints 1 or 0. Reads
    // only TRACKED files (git ls-files), so files written in this run do not count.
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    let out = '0';
    try {
      const shows = JSON.parse(fs.readFileSync(b, 'utf8'));
      const show = (Array.isArray(shows) ? shows : shows.shows).find((s) => s.id === a);
      if (!show) throw new Error(`show ${a} not in ${b}`);
      const tracked = execFileSync('git', ['-C', c, 'ls-files', '--', a], { encoding: 'utf8' })
        .split('\n').filter((f) => f.endsWith('.json') && !path.basename(f).startsWith('_'));
      const files = tracked.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(c, f), 'utf8')); } catch (_) { return null; } });
      out = isFirstWave(show, files, new Date(), process.argv[6] === undefined ? 3 : Number(process.argv[6])) ? '1' : '0';
    } catch (e) { console.error(`::warning::first-wave check failed for ${a}: ${e.message}`); out = '0'; }
    console.log(out);
  } else if (cmd === 'break') {
    // break <polled> <total> <front> <mainFrontEnd> <hotNewCount> <firstWaveNewCount> [minNew]
    const [, p, t, f, m, h, fwn, mn] = process.argv.slice(2);
    console.log(shouldBreakEarly({ polled: Number(p), total: Number(t), front: Number(f), mainFrontEnd: Number(m), hotNewCount: Number(h), firstWaveNewCount: Number(fwn) || 0, minNew: mn === undefined ? 3 : Number(mn) }) ? '1' : '0');
  } else { console.error('usage: rotate <csv> <seed> | timeout <remainingSec> [capSec] | first-wave <id> <showsJson> <dir> | break ...'); process.exit(2); }
}
