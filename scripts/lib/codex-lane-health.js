'use strict';
// BRO-6134 stage 1: ONE pure health function for the Codex lanes, read from OUTSIDE signals.
// Seven regressions in 18 days (2026-10-10..10-23) were each found by a person 2-36h late;
// the only alarm (runnerHealth: "zero landed in 24h") caught none. Inputs, all read by the
// caller (scripts/codex-lane-alarm.js) so this file stays I/O-free and unit-testable:
//  - landed: Codex-runner landings on origin/main (git log), { ms }[]
//  - summaries: the runner's "## Codex runner" comments on BRO-4745 (all pages), { createdAt, body }[]
//  - ghRuns: codex-runner.yml run list, { startMs, endMs, durationMin, conclusion }[]
//  - lockAgeH: age of the cloud lane's lock holder in hours; when null it is read from the newest
//    cloud "lock-held" stand-down note in summaries (BRO-6139: the note carries the holder's start)
//  - login: the stored login's public stamps on BRO-4799 (parseAuthMeta), { lastRefreshMs, savedMs, accessExpiresMs }
// summaries also carry the runner's stand-down notes ("## Codex runner did not start ... (reason X)"),
// so a lane that exits without working says why (BRO-6139 stage 2).
// A source passed as null is "health unknown", never a breach and never a crash.
// The summary parser and lane attribution come from the protected grading file itself (BRO-6303).
const { runnerSummaryFacts, parseSummaryHeading, laneOfSummary } = require('./codex-runner-grading.js');
const { landedPerLane, parseStandDownNote } = require('./codex-runner.js');

const HOUR = 3600_000;

// Human-set floors from the 30-day history (BRO-6134). No rolling median until 14 clean days.
// Healthy days 10-19..10-21 landed 25-37 Codex cards/day, never fewer than 2 in any 6h block
// and never fewer than 7 in any 12h block; the cloud lane posts a summary every ~2h.
const FLOORS = Object.freeze({
  landedWindowH: 12,
  landedMin: 3,            // 30% of the ~10 landings a healthy 12h brings
  cloudSilentH: 3.5,        // cloud lane fires every 2h; healthy gaps peaked at 3.0h (10-19..10-21)
  cloudLandWindowH: 6,     // cloud lane landed nothing in 6h while working 3+ cards (healthy 6h blocks never had zero)
  cloudLandMinWorked: 3,
  ghaSilentH: 10,          // gha crons 01/06/11/16/21 (:13 UTC); GitHub drops the 16:13 slot most days, so healthy gaps reach 8.5h
  ghaStandDownMin: 6,      // a run that did work takes 100+ min; stand-downs take 2-3
  lockStaleH: 6,           // hard stop is 290 min; a lock older than 6h is a dead run's
  stopStreakOf: 3, stopStreakMin: 2,
  // The CLI refreshes the login only at access-token expiry; the run that refreshed saves it at its
  // end (gha hard stop 290 min), so a refresh not saved 6h after expiry is lost (the E6 class).
  loginSaveGraceH: 6,
  // Until a save records access_expires, expiry is estimated from last_refresh: the one observed
  // token life was 10 days (2026-10-05 -> 10-15).
  loginLifeH: 240,
  // A gha run stands aside when the login expires within its run (hard stop 290 min) plus 30 min margin.
  ghaRefreshWindowH: 5.5,
});

// "Stopped early" reasons that mean the lane cannot work (lock, disk, Done gate, REJECT streak, crash, limit).
// A stop for lack of disk (R.stopReason, R.isDiskFailure): reported by its own class on the first
// occurrence, because a full disk repeats until someone frees it (BRO-6304).
const DISK_STOP = /GB of disk left|No space left on device|\bENOSPC\b/i;
const BLOCKING_STOP = /\block\b|disk|Done gate refused|REJECTs? in a row|Codex exited|usage limit|limit reached|login|did not start/i;
// Stand-down classes that are not a fault: another run is working (lock-held) or the lane steps
// aside on purpose while the login may refresh (login-refresh). Every other class blocks the lane.
const BENIGN_STAND_DOWN = new Set(['lock-held', 'login-refresh']);

/** Codex-runner landings from `git log` text in LANDED_LOG_FORMAT prefixed with the commit time: "<ms>\t<log line>". */
function codexLandedEvents(logLines) {
  const out = [];
  for (const raw of String(logLines || '').split('\n')) {
    const i = raw.indexOf('\t');
    if (i < 0) continue;
    const ms = Number(raw.slice(0, i));
    if (Number.isFinite(ms) && landedPerLane(raw.slice(i + 1)).codex > 0) out.push({ ms });
  }
  return out;
}

/**
 * -> { status: 'pass'|'breach'|'unknown', breaches: [{ lane, cls, why }], unknown: [string], facts }
 * `unknown` lists unreadable sources; status is 'unknown' only when nothing was breached and a
 * source was unreadable.
 */
function codexLaneHealth({ nowMs, landed = null, summaries = null, ghRuns = null, lockAgeH = null, login = undefined, floors = FLOORS } = {}) {
  const breaches = []; const unknown = []; const facts = {}; const stand = {};
  const breach = (lane, cls, why) => breaches.push({ lane, cls, why });

  let expMs = NaN; // the stored login's access-token expiry
  // login not passed at all (the backtest: BRO-4799 keeps no history) is skipped; null is unreadable.
  if (login === null) unknown.push('BRO-4799 login stamps');
  else if (login !== undefined) {
    const est = !Number.isFinite(login.accessExpiresMs);
    expMs = est ? login.lastRefreshMs + floors.loginLifeH * HOUR : login.accessExpiresMs;
    if (Number.isFinite(expMs)) {
      facts.loginExpires = `${new Date(expMs).toISOString().slice(0, 16)}Z${est ? ' (estimated from last_refresh)' : ''}`;
      // A saved refresh moves last_refresh (and access_expires) forward, so a stored expiry this far
      // in the past means the refresh at expiry never reached BRO-4799.
      if (nowMs > expMs + floors.loginSaveGraceH * HOUR) {
        breach('codex', 'login-not-saved', `the stored Codex login expired ${facts.loginExpires} and no refreshed login was saved to BRO-4799 in the ${floors.loginSaveGraceH}h since (last_refresh ${Number.isFinite(login.lastRefreshMs) ? `${new Date(login.lastRefreshMs).toISOString().slice(0, 16)}Z` : 'unknown'})`);
      }
    } else unknown.push('BRO-4799 login expiry');
  }

  if (landed === null) unknown.push('git landings');
  else {
    const n = landed.filter((e) => e.ms <= nowMs && nowMs - e.ms <= floors.landedWindowH * HOUR).length;
    facts.landedWindow = n;
    if (n < floors.landedMin) breach('codex', 'landed-low', `${n} Codex card(s) landed on main in the last ${floors.landedWindowH}h (a healthy half-day lands about 10; floor ${floors.landedMin})`);
  }

  if (summaries === null) unknown.push('BRO-4745 summaries');
  else {
    const seen = summaries.filter((c) => c && Number.isFinite(Date.parse(c.createdAt)) && Date.parse(c.createdAt) <= nowMs);
    const runs = seen
      .map((c) => ({ c, ms: Date.parse(c.createdAt), h: parseSummaryHeading(c.body) }))
      .filter((r) => r.h)
      .map(({ c, ms, h }) => ({ ms, lane: laneOfSummary(c.body, ms, ghRuns), f: runnerSummaryFacts(c.body), worked: h.worked }))
      .sort((a, b) => b.ms - a.ms);
    const notes = seen.map((c) => ({ ms: Date.parse(c.createdAt), n: parseStandDownNote(c.body) })).filter((x) => x.n)
      .map(({ ms, n }) => ({ ms, ...n })).sort((a, b) => b.ms - a.ms);
    stand.notes = notes;
    const cloud = runs.filter((r) => r.lane === 'cloud');
    facts.cloudSummaries = cloud.length;
    facts.ghaSummaries12h = runs.filter((r) => r.lane === 'gha' && nowMs - r.ms <= 12 * HOUR).length;
    const cloudNotes = notes.filter((x) => x.lane === 'cloud');
    if (cloudNotes.length && nowMs - cloudNotes[0].ms <= 12 * HOUR) facts.cloudLastStandDown = cloudNotes[0].cls;
    const newestNote = cloudNotes[0] && (!cloud.length || cloudNotes[0].ms > cloud[0].ms) ? cloudNotes[0] : null;
    // A held lock means a run is still working; how long it has held it feeds lock-stale. Any lane's
    // later summary ends that (a gha fallback on slot 0 holds the cloud lane's slot-0 lock).
    if (lockAgeH === null && newestNote && newestNote.cls === 'lock-held' && (!runs.length || newestNote.ms > runs[0].ms) && Number.isFinite(newestNote.holderStartedMs) && nowMs - newestNote.ms <= 3 * HOUR) {
      lockAgeH = (nowMs - newestNote.holderStartedMs) / HOUR;
    }
    if (!cloud.length || nowMs - cloud[0].ms > floors.cloudSilentH * HOUR) {
      const said = newestNote ? `; its last word was a stand-down (${newestNote.cls}): ${newestNote.why.split('\n')[0].slice(0, 90)}` : '';
      breach('cloud', 'no-run', (cloud.length
        ? `no cloud-lane summary for ${((nowMs - cloud[0].ms) / HOUR).toFixed(1)}h (it posts about every 2h)`
        : 'no cloud-lane summary on BRO-4745 at all') + said);
    } else {
      // A stand-down for a blocking reason (login, sandbox, tools, picker, crash) is a run that stopped.
      // The slots of one launch each post the same failure within minutes: count it once per launch.
      const blockedNotes = cloudNotes.filter((x) => !BENIGN_STAND_DOWN.has(x.cls))
        .filter((x, i, a) => !a.slice(i + 1).some((y) => y.cls === x.cls && x.ms - y.ms <= 15 * 60_000))
        .map((x) => ({ ms: x.ms, worked: 0, f: { landed: 0, stop: `did not start (${x.cls}): ${x.why.split('\n')[0]}` } }));
      const recent = [...cloud, ...blockedNotes].sort((a, b) => b.ms - a.ms).filter((r) => nowMs - r.ms <= 12 * HOUR).slice(0, floors.stopStreakOf);
      const blocked = recent.filter((r) => BLOCKING_STOP.test(r.f.stop));
      // The newest summary must itself be blocked, so the breach clears at the first healthy run.
      if (recent.length >= floors.stopStreakMin && blocked.length >= floors.stopStreakMin && BLOCKING_STOP.test(recent[0].f.stop)) {
        breach('cloud', 'stopped', `${blocked.length} of the last ${recent.length} cloud summaries stopped early: ${blocked[0].f.stop.slice(0, 90)}`);
      }
    }
    // Judged on the parsed stop reason, never the summary body: bodies quote card titles and check output.
    const diskStops = cloud.filter((r) => nowMs - r.ms <= 12 * HOUR && DISK_STOP.test(r.f.stop || ''));
    if (diskStops.length && cloud.length && DISK_STOP.test(cloud[0].f.stop || '')) {
      breach('cloud', 'disk-low', `${diskStops.length} cloud summary(ies) in 12h stopped on disk: ${diskStops[0].f.stop.slice(0, 90)}`);
    }
    const win = cloud.filter((r) => nowMs - r.ms <= floors.cloudLandWindowH * HOUR);
    const worked = win.reduce((a, r) => a + r.worked, 0);
    if (cloud.length && win.length >= 2 && worked >= floors.cloudLandMinWorked && win.every((r) => r.f.landed === 0)) {
      breach('cloud', 'landed-none', `the cloud lane worked ${worked} card(s) in ${win.length} runs over ${floors.cloudLandWindowH}h and landed none`);
    }
  }

  if (ghRuns === null) unknown.push('codex-runner.yml run list');
  else {
    // A run that had not ended at nowMs is unfinished then, even if it has a conclusion now (hour-earlier replay).
    const runs = ghRuns.filter((r) => Number.isFinite(r.startMs) && r.startMs <= nowMs)
      .map((r) => (Number.isFinite(r.endMs) && r.endMs > nowMs ? { ...r, conclusion: null } : r))
      .sort((a, b) => b.startMs - a.startMs);
    facts.ghaRuns = runs.length;
    if (runs.length) {
      if (nowMs - runs[0].startMs > floors.ghaSilentH * HOUR) {
        breach('gha', 'no-run', `no codex-runner.yml run for ${((nowMs - runs[0].startMs) / HOUR).toFixed(1)}h (cron 01/06/11/16/21 UTC)`);
      } else {
        const done = runs.filter((r) => r.conclusion).slice(0, 2);
        if (done.length === 2 && done.every((r) => r.conclusion === 'success' && r.durationMin < floors.ghaStandDownMin)) {
          // The run's own stand-down note says why (BRO-6139). Deliberate (the login may refresh during
          // the run, so the gha lane steps aside) only while the stored login's expiry is within one run
          // of that firing: E6 was this very stand-down stuck on for days by a gate that never cleared.
          // The login check above covers a refresh that never comes.
          const why = done.map((r) => (stand.notes || []).find((x) => x.lane === 'gha' && x.ms >= r.startMs - 60_000 && x.ms <= (Number.isFinite(r.endMs) ? r.endMs : nowMs) + 5 * 60_000));
          // Judged against the expiry the stand-down itself saw (its note's stamp), else the stored one now.
          const nearExpiry = (r, x) => {
            const e = Number.isFinite(x.loginExpiresMs) ? x.loginExpiresMs : expMs;
            return Number.isFinite(e) && r.startMs >= e - floors.ghaRefreshWindowH * HOUR && r.startMs <= e + floors.loginSaveGraceH * HOUR;
          };
          if (why.every((x, i) => x && x.cls === 'login-refresh' && nearExpiry(done[i], x))) facts.ghaStandDown = 'login-refresh (deliberate, login expiry near)';
          else {
            const said = why.find((x) => x && x.cls !== 'login-refresh');
            const stuck = !said && why.some((x) => x && x.cls === 'login-refresh');
            const detail = said ? ` (${said.cls}: ${said.why.split('\n')[0].slice(0, 90)})`
              : stuck ? ` (login-refresh, but the stored login expires ${facts.loginExpires || 'at an unreadable time'}, not within a run of these firings: the stand-down is stuck on)`
                : ' and said nothing';
            breach('gha', 'stand-down', `the last 2 codex-runner.yml runs ended green in ${done.map((r) => Math.round(r.durationMin)).join(' and ')} min: the lane did no work${detail}`);
          }
        } else if (done.length === 2 && done.every((r) => r.conclusion === 'failure')) {
          breach('gha', 'failing', 'the last 2 codex-runner.yml runs failed');
        }
      }
    }
  }

  if (lockAgeH !== null && Number.isFinite(lockAgeH)) {
    facts.lockAgeH = lockAgeH;
    if (lockAgeH > floors.lockStaleH) breach('cloud', 'lock-stale', `the runner lock stamp is ${lockAgeH.toFixed(1)}h old (a run ends within ~5h)`);
  }

  return { status: breaches.length ? 'breach' : (unknown.length ? 'unknown' : 'pass'), breaches, unknown, facts };
}

/**
 * Two consecutive hourly evaluations (now and an hour ago, from the same inputs) must breach
 * the same lane:class before a card is filed. -> breaches confirmed [{ lane, cls, why }]
 */
function confirmedBreaches(inputs, { consecutive = 2 } = {}) {
  const now = codexLaneHealth(inputs);
  if (consecutive <= 1) return { now, prev: [], confirmed: now.breaches };
  const prev = [];
  for (let k = 1; k < consecutive; k++) prev.push(codexLaneHealth({ ...inputs, nowMs: inputs.nowMs - k * HOUR }));
  const confirmed = now.breaches.filter((b) => prev.every((p) => p.breaches.some((x) => x.lane === b.lane && x.cls === b.cls)));
  return { now, prev, confirmed };
}

module.exports = { DISK_STOP, FLOORS, BLOCKING_STOP, BENIGN_STAND_DOWN, codexLandedEvents, codexLaneHealth, confirmedBreaches };
