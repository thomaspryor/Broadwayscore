'use strict';
// BRO-6134 stage 1: ONE pure health function for the Codex lanes, read from OUTSIDE signals.
// Seven regressions in 18 days (2026-10-10..10-23) were each found by a person 2-36h late;
// the only alarm (runnerHealth: "zero landed in 24h") caught none. Inputs, all read by the
// caller (scripts/codex-lane-alarm.js) so this file stays I/O-free and unit-testable:
//  - landed: Codex-runner landings on origin/main (git log), { ms }[]
//  - summaries: the runner's "## Codex runner" comments on BRO-4745 (all pages), { createdAt, body }[]
//  - ghRuns: codex-runner.yml run list, { startMs, durationMin, conclusion }[]
//  - lockAgeH: age of the runner lock stamp in hours, or null when unread
// A source passed as null is "health unknown", never a breach and never a crash.
const { runnerSummaryFacts, landedPerLane } = require('./codex-runner.js');

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
});

// "Stopped early" reasons that mean the lane cannot work (lock, disk, Done gate, REJECT streak, crash, limit).
const BLOCKING_STOP = /\block\b|disk|Done gate refused|REJECTs? in a row|Codex exited|usage limit|limit reached|login/i;

const slotOf = (body) => Number((String(body || '').split('\n')[0].match(/\(slot (\d+)\)/) || [])[1] || 0);

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
function codexLaneHealth({ nowMs, landed = null, summaries = null, ghRuns = null, lockAgeH = null, floors = FLOORS } = {}) {
  const breaches = []; const unknown = []; const facts = {};
  const breach = (lane, cls, why) => breaches.push({ lane, cls, why });

  if (landed === null) unknown.push('git landings');
  else {
    const n = landed.filter((e) => e.ms <= nowMs && nowMs - e.ms <= floors.landedWindowH * HOUR).length;
    facts.landedWindow = n;
    if (n < floors.landedMin) breach('codex', 'landed-low', `${n} Codex card(s) landed on main in the last ${floors.landedWindowH}h (a healthy half-day lands about 10; floor ${floors.landedMin})`);
  }

  if (summaries === null) unknown.push('BRO-4745 summaries');
  else {
    const runs = summaries
      .filter((c) => c && /^## Codex runner \d{4}-\d{2}-\d{2}:/.test(String(c.body || '')) && Number.isFinite(Date.parse(c.createdAt)) && Date.parse(c.createdAt) <= nowMs)
      .map((c) => ({ ms: Date.parse(c.createdAt), slot: slotOf(c.body), f: runnerSummaryFacts(c.body), worked: Number((String(c.body).match(/^## Codex runner \S+: (\d+) card\(s\) worked/) || [])[1]) || 0 }))
      .sort((a, b) => b.ms - a.ms);
    const cloud = runs.filter((r) => r.slot < 3);
    facts.cloudSummaries = cloud.length;
    facts.ghaSummaries12h = runs.filter((r) => r.slot >= 3 && nowMs - r.ms <= 12 * HOUR).length;
    if (!cloud.length || nowMs - cloud[0].ms > floors.cloudSilentH * HOUR) {
      breach('cloud', 'no-run', cloud.length
        ? `no cloud-lane summary for ${((nowMs - cloud[0].ms) / HOUR).toFixed(1)}h (it posts about every 2h)`
        : 'no cloud-lane summary on BRO-4745 at all');
    } else {
      const recent = cloud.filter((r) => nowMs - r.ms <= 12 * HOUR).slice(0, floors.stopStreakOf);
      const blocked = recent.filter((r) => BLOCKING_STOP.test(r.f.stop));
      // The newest summary must itself be blocked, so the breach clears at the first healthy run.
      if (recent.length >= floors.stopStreakMin && blocked.length >= floors.stopStreakMin && BLOCKING_STOP.test(recent[0].f.stop)) {
        breach('cloud', 'stopped', `${blocked.length} of the last ${recent.length} cloud summaries stopped early: ${blocked[0].f.stop.slice(0, 90)}`);
      }
    }
    const win = cloud.filter((r) => nowMs - r.ms <= floors.cloudLandWindowH * HOUR);
    const worked = win.reduce((a, r) => a + r.worked, 0);
    if (cloud.length && win.length >= 2 && worked >= floors.cloudLandMinWorked && win.every((r) => r.f.landed === 0)) {
      breach('cloud', 'landed-none', `the cloud lane worked ${worked} card(s) in ${win.length} runs over ${floors.cloudLandWindowH}h and landed none`);
    }
  }

  if (ghRuns === null) unknown.push('codex-runner.yml run list');
  else {
    const runs = ghRuns.filter((r) => Number.isFinite(r.startMs) && r.startMs <= nowMs).sort((a, b) => b.startMs - a.startMs);
    facts.ghaRuns = runs.length;
    if (runs.length) {
      if (nowMs - runs[0].startMs > floors.ghaSilentH * HOUR) {
        breach('gha', 'no-run', `no codex-runner.yml run for ${((nowMs - runs[0].startMs) / HOUR).toFixed(1)}h (cron 01/06/11/16/21 UTC)`);
      } else {
        const done = runs.filter((r) => r.conclusion).slice(0, 2);
        if (done.length === 2 && done.every((r) => r.conclusion === 'success' && r.durationMin < floors.ghaStandDownMin)) {
          breach('gha', 'stand-down', `the last 2 codex-runner.yml runs ended green in ${done.map((r) => Math.round(r.durationMin)).join(' and ')} min: the lane did no work`);
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

module.exports = { FLOORS, BLOCKING_STOP, codexLandedEvents, codexLaneHealth, confirmedBreaches };
