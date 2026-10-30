'use strict';
/**
 * BRO-6621 (plan v2 step 6): start the opening-night lane and its watchdog with no cron on the critical path, and fall
 * back to the old path once when the lane dies.
 *
 *   Starter   The orchestrator ("Start lane night + watchdog") runs this on every tick. On a show's opening day,
 *             inside [embargo - 20h, embargo + 1h], it dispatches two separate workflow runs: the lane night run
 *             (opening-night-lane-live.yml mode=night) and the watchdog (opening-night-lane-watchdog.yml). Any one of
 *             the orchestrator's daily crons is enough, however late it fires. It starts nothing unless
 *             LANE_ONLY_MARKETS was read and covers the show: that variable being unset is the shadow hold, so a held
 *             night never starts night mode (planNightStart).
 *   Night     The lane run's night-wait job sleeps until lane start (embargo - 30 min) and re-dispatches itself when
 *             the wait is longer than one job may run, so every job stays under GitHub's 360-minute cap
 *             (planNightWait). The concurrency group is per show, so two shows on one night run side by side.
 *   Watchdog  A separate self-chaining run that checks the lease every 5 minutes (decideWatchdog). When the lane has
 *             been dead for the lease TTL it releases the dead lease FIRST (releaseDeadLease, a compare-and-swap that
 *             refuses a live lease), then dispatches the old path (opening-night-orchestrator.yml for the show) once,
 *             then stops. Paging per BRO-4603: a digest row and a red run, never a phone page.
 *
 * Pure decision functions plus runWatchdogTick with injected ports; scripts/lane-auto-fallback.js (starter, night-wait) and scripts/lane-watchdog.js are the CLIs.
 */
const { liveLeaseFor, embargoForNight, parseOnlyMarkets } = require('./lane-only-markets');
const { tokensMatchShow, standsDown } = require('./standdown');

const MIN = 60 * 1000;
const LEASE_TTL_MIN = 30;           // lease.js DEFAULT_TTL_MS
const LANE_LEAD_MIN = 30;           // the lane starts this long before the embargo
const LANE_WINDOW_MIN = 270;        // OPENING_NIGHT_LANE_WINDOW_MIN in opening-night-lane-live.yml
const START_BEFORE_MIN = 20 * 60;   // starter window opens 20h before the embargo (covers opening day's crons)
const START_AFTER_MIN = 60;         // and closes 1h after it; later than that the old path keeps the night
const WAIT_JOB_BUDGET_MIN = 330;    // longest sleep in one night-wait / watchdog job (job cap 350, GitHub 360)
const TICK_MIN = 5;

const nightRunTitle = (show, night) => `Opening-night lane night ${show} ${night}`;
const watchdogRunTitle = (show, night) => `Opening-night lane watchdog ${show} ${night}`;
const leaseKey = (show, night) => `${show}|${night}`;
const toMs = (t) => (t === undefined ? Date.now() : new Date(t).getTime());

/** Lane start and the watchdog's window for one show-night, or null when the embargo is unknown. Pure. */
function nightTimes(show, night) {
  const embargoMs = Date.parse(embargoForNight(show, night) || '');
  if (!Number.isFinite(embargoMs)) return null;
  const laneStartMs = embargoMs - LANE_LEAD_MIN * MIN;
  return { embargoMs, laneStartMs, watchEndMs: laneStartMs + (LANE_WINDOW_MIN + LEASE_TTL_MIN) * MIN };
}

/** Does a read LANE_ONLY_MARKETS ({ok, value}) cover the show? Unread, unset or a typo = no. Pure. */
function laneOnlyCovers(onlyMarkets, show) {
  return !!(onlyMarkets && onlyMarkets.ok && tokensMatchShow(parseOnlyMarkets(onlyMarkets.value).tokens, show));
}

/**
 * Starter: should this tick dispatch the lane night run and the watchdog for `show`? Pure.
 * @param {{show:object, now?:any, onlyMarkets:{ok:boolean,value?:string}, standdown:{ok:boolean,value?:string},
 *          armed:boolean, seenTitles:string[]|null}} input  seenTitles: lane-night and watchdog run titles from the
 *          last day, any status (null = the run list failed).
 * @returns {{start:boolean, reason:string, night?:string, watchdogOnly?:boolean}}  watchdogOnly: dispatch only the watchdog
 */
function planNightStart({ show, now, onlyMarkets, standdown, armed, seenTitles }) {
  const nowMs = toMs(now);
  const no = (reason) => ({ start: false, reason });
  if (!show || !show.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(show.openingDate || ''))) return no('no opening night');
  const night = show.openingDate;
  const t = nightTimes(show, night);
  if (!t) return no('embargo unknown');
  if (nowMs < t.embargoMs - START_BEFORE_MIN * MIN) return no('before the start window');
  if (nowMs > t.embargoMs + START_AFTER_MIN * MIN) return no('after the start window');
  // The shadow hold: only an owner-set LANE_ONLY_MARKETS naming the show starts night mode.
  if (!laneOnlyCovers(onlyMarkets, show)) return no('LANE_ONLY_MARKETS does not cover the show (shadow hold)');
  if (!standdown || !standdown.ok) return no('LANE_STANDDOWN unreadable');
  if (standsDown(standdown.value, show)) return no('LANE_STANDDOWN covers the show');
  if (!armed) return no('lane not armed');
  if (!Array.isArray(seenTitles)) return no('run list unreadable');
  // Once per show-night: a watchdog that already ran (and maybe fell back) must not be followed by a fresh lane.
  if (seenTitles.includes(watchdogRunTitle(show.id, night))) return no('watchdog already started for this night');
  // The lane run started but its watchdog dispatch failed: start the watchdog alone on this tick.
  if (seenTitles.includes(nightRunTitle(show.id, night))) return { start: true, watchdogOnly: true, reason: 'lane night run started without its watchdog', night };
  return { start: true, watchdogOnly: false, reason: 'opening day, lane-only, armed', night };
}

/**
 * night-wait job: how long to sleep before the lane starts. Pure.
 * @returns {{action:'go'|'sleep-go'|'sleep-chain'|'late'|'unknown', sleepMin:number, reason:string}}
 *   go          start the lane now
 *   sleep-go    sleep sleepMin, recheck the hold, then start
 *   sleep-chain sleep sleepMin (the whole budget), then dispatch the next hop and end without starting
 *   late        more than an hour past the embargo: do not start (the watchdog falls back)
 */
function planNightWait({ show, night, now }) {
  const nowMs = toMs(now);
  const t = show && nightTimes(show, night);
  if (!t) return { action: 'unknown', sleepMin: 0, reason: 'embargo unknown' };
  if (nowMs > t.embargoMs + START_AFTER_MIN * MIN) return { action: 'late', sleepMin: 0, reason: 'more than 1h past the embargo' };
  const waitMin = Math.ceil((t.laneStartMs - nowMs) / MIN);
  if (waitMin <= 0) return { action: 'go', sleepMin: 0, reason: 'lane start reached' };
  if (waitMin <= WAIT_JOB_BUDGET_MIN) return { action: 'sleep-go', sleepMin: waitMin, reason: `lane starts in ${waitMin} min` };
  return { action: 'sleep-chain', sleepMin: WAIT_JOB_BUDGET_MIN, reason: `lane starts in ${waitMin} min; chaining` };
}

/**
 * Watchdog tick. Pure.
 * @param {{show:object, night:string, now?:any, leaseState:object|null, laneRun:{status:string, createdAt?:string}|null,
 *          sinceMs?:number, fallbackDone?:boolean, onlyMarkets?:{ok:boolean,value?:string},
 *          standdown?:{ok:boolean,value?:string}}} input
 *   leaseState null or {unknown:true} = unreadable. laneRun.status: 'active' (queued/in progress/waiting),
 *   'success', 'failure' (any other conclusion), 'none' (no run with the night title), 'unknown' (list failed).
 *   sinceMs: when the first watchdog hop started (a run that never appears is judged from then).
 *   leaseSeen: this watchdog (any hop) saw a live lease for the night. A lane run that ended green without ever
 *   holding one never ran the lane (a sleep-chain hop, a late start, a hold-check refusal), so it is not a stop.
 * @returns {{action:'wait'|'stop'|'fallback', reason:string, release?:boolean, digest?:boolean}}
 *   fallback: release the dead lease when `release`, then dispatch the old path once; `digest` = page (digest row + red run).
 */
function decideWatchdog({ show, night, now, leaseState, laneRun, sinceMs, fallbackDone, leaseSeen, onlyMarkets, standdown }) {
  const nowMs = toMs(now);
  const wait = (reason) => ({ action: 'wait', reason });
  const stop = (reason) => ({ action: 'stop', reason });
  const fallback = (reason, { release = false, digest = true } = {}) => ({ action: 'fallback', reason, release, digest });
  if (fallbackDone) return stop('old path already dispatched for this night');
  const t = show && show.id && nightTimes(show, night);
  if (!t) return fallback('embargo unknown', { digest: true });
  if (nowMs >= t.watchEndMs) return stop('past the lane window');
  // Nothing can be dead before the lane is due to start; the old path is the default until then anyway.
  if (nowMs < t.laneStartMs) return wait('before lane start');

  const ttl = LEASE_TTL_MIN * MIN;
  const known = leaseState && !leaseState.unknown;
  const entry = known ? (leaseState.leases || {})[leaseKey(show.id, night)] : null;
  if (known && entry) {
    const live = liveLeaseFor({ leases: { [leaseKey(show.id, night)]: entry } }, show.id, nowMs);
    if (live) return { ...wait(`lane ${live.holder} holds the lease`), leaseLive: true };
    // Expired: no heartbeat for the whole TTL, so the lane died holding it.
    const hold = holdReason({ show, onlyMarkets, standdown });
    return fallback(`lease of ${entry.holder} expired at ${entry.expiresAt} (no heartbeat for ${LEASE_TTL_MIN} min)`,
      { release: true, digest: !hold });
  }

  // From here: no lease for the night (or the lease state is unreadable).
  const status = laneRun && laneRun.status;
  if (status === 'success' && leaseSeen) return stop('lane run finished and released its lease');
  const hold = holdReason({ show, onlyMarkets, standdown });
  if (hold) return fallback(`${hold}; the old path keeps the night`, { digest: false });
  if (status === 'failure') return fallback('lane run failed without a lease (it already went red)', { digest: false });
  if (status === 'success') return fallback('lane run ended green without ever holding the lease (the lane never ran)');
  if (!known) return wait('lease state unreadable');
  if (status === 'active') {
    const createdMs = Date.parse((laneRun && laneRun.createdAt) || '');
    const startMs = Math.max(t.laneStartMs, Number.isFinite(createdMs) ? createdMs : 0);
    if (nowMs >= startMs + ttl) return fallback(`lane run never claimed the lease within ${LEASE_TTL_MIN} min of its start`);
    return wait('lane run starting');
  }
  if (status === 'none') {
    const startMs = Math.max(t.laneStartMs, Number.isFinite(sinceMs) ? sinceMs : 0);
    if (nowMs >= startMs + ttl) return fallback('no lane night run exists (the chain broke)');
    return wait('lane run not seen yet');
  }
  return wait('lane run status unknown');
}

/** An owner switch that means the lane is not meant to publish this show tonight, or null. Only read values count. Pure. */
function holdReason({ show, onlyMarkets, standdown }) {
  if (standdown && standdown.ok && standsDown(standdown.value, show)) return 'LANE_STANDDOWN covers the show';
  if (onlyMarkets && onlyMarkets.ok && !laneOnlyCovers(onlyMarkets, show)) return 'LANE_ONLY_MARKETS no longer covers the show';
  return null;
}

/**
 * Lease transition for lease-store.casTransition: delete the show-night lease only when it is no longer live. A lane
 * that heartbeated since the watchdog looked keeps its lease (refused), so a lane that came back is never cut off.
 * No lease = nothing to release (ok, idempotent). Pure.
 */
function releaseDeadLease(state, { show, night, now }) {
  const nowMs = toMs(now);
  const key = leaseKey(show, night);
  const leases = { ...((state && state.leases) || {}) };
  const entry = leases[key];
  if (!entry) return { ok: true, released: false, state: { ...(state || {}), leases } };
  if (Date.parse(entry.expiresAt) > nowMs) return { ok: false, reason: 'lease-live', holder: entry.holder };
  delete leases[key];
  return { ok: true, released: true, holder: entry.holder, state: { ...state, leases } };
}

/** Branch holding the per-night fallback claims, apart from the lease branch: lease-store commits one file per tip. */
const FALLBACK_BRANCH = 'opening-night-lane-fallbacks';
/** A claim keeps its night for 3 days (lease-store sweeps expired entries); one not marked dispatched is retaken after 10 min. */
const CLAIM_TTL_MIN = 3 * 24 * 60;
const CLAIM_STALE_MIN = 10;

/**
 * Fallback claim transition for lease-store.casTransition on FALLBACK_BRANCH: the atomic once-per-night guard. Two
 * watchdogs for the same night (a re-dispatch, a stray manual run) race through compare-and-swap; only one gets the
 * claim and dispatches. Refused: already dispatched by anyone, or claimed by another holder in the last 10 min. Pure.
 */
function claimFallback(state, { show, night, holder, now }) {
  const nowMs = toMs(now);
  const key = leaseKey(show, night);
  const leases = { ...((state && state.leases) || {}) };
  const cur = leases[key];
  if (cur && Date.parse(cur.expiresAt) > nowMs) {
    if (cur.dispatched) return { ok: false, reason: 'already-dispatched', holder: cur.holder };
    if (cur.holder !== holder && nowMs - Date.parse(cur.acquiredAt) < CLAIM_STALE_MIN * MIN) return { ok: false, reason: 'claim-in-flight', holder: cur.holder };
  }
  const at = new Date(nowMs).toISOString();
  leases[key] = { holder, acquiredAt: at, heartbeatAt: at, expiresAt: new Date(nowMs + CLAIM_TTL_MIN * MIN).toISOString(), dispatched: false };
  return { ok: true, state: { ...(state || {}), leases } };
}

/** Marks this holder's claim dispatched, so no later watchdog dispatches again. Pure. */
function markFallbackDispatched(state, { show, night, holder, now }) {
  const key = leaseKey(show, night);
  const leases = { ...((state && state.leases) || {}) };
  const cur = leases[key];
  if (!cur || cur.holder !== holder) return { ok: false, reason: 'claim-lost' };
  leases[key] = { ...cur, dispatched: true, heartbeatAt: new Date(toMs(now)).toISOString() };
  return { ok: true, state: { ...state, leases } };
}

/** Ticks in a row a claim may fail to write (branch unreachable) before the watchdog dispatches without it. */
const CLAIM_FAILURES_BEFORE_DISPATCH = 3;

/**
 * One watchdog tick with injected ports. Order on fallback: release (when the lease expired) -> claim the night ->
 * dispatch -> mark dispatched -> page. A refused release (the lane heartbeated in between) waits instead. A failed
 * release still goes on: an expired lease is already invisible to every reader (lane-only-markets liveLeaseFor,
 * lease-guard), so it cannot hold the old path off. A claim already dispatched by another watchdog stops without a
 * second dispatch; one in flight waits. A claim that cannot be written waits, and after 3 such ticks dispatches anyway
 * (a duplicate old-path run is cheaper than none). Returns the decision plus what was done.
 * @param {object} input decideWatchdog input minus leaseState/laneRun/onlyMarkets/standdown, plus holder and
 *   claimFailures (consecutive failed claim writes so far)
 * @param {{readLeaseState:()=>object|null, laneRunStatus:()=>object|null, readVars:()=>{onlyMarkets,standdown},
 *          release:(fn)=>{ok:boolean,reason?:string,released?:boolean}, claim:(fn)=>{ok:boolean,reason?:string},
 *          dispatchOldPath:()=>boolean, page:(decision)=>void, log?:(s:string)=>void}} ports
 */
function runWatchdogTick(input, ports) {
  const log = ports.log || (() => {});
  const vars = ports.readVars();
  const decision = decideWatchdog({ ...input, ...vars, leaseState: ports.readLeaseState(), laneRun: ports.laneRunStatus() });
  log(`watchdog ${input.show && input.show.id} ${input.night}: ${decision.action} (${decision.reason})`);
  if (decision.action !== 'fallback') return { ...decision, done: decision.action === 'stop' };
  const args = { show: input.show.id, night: input.night, now: input.now };
  if (decision.release) {
    const r = ports.release((s) => releaseDeadLease(s, args));
    if (!r.ok && r.reason === 'lease-live') {
      log('lease is live again (the lane heartbeated); no fallback');
      return { action: 'wait', reason: 'lease renewed before release', leaseLive: true, done: false };
    }
    log(r.ok ? `released dead lease (${r.released ? r.holder : 'already gone'})` : `release failed (${r.reason}); going on`);
  }
  const holder = input.holder || 'watchdog';
  const c = ports.claim((s) => claimFallback(s, { ...args, holder }));
  let claimFailures = input.claimFailures || 0;
  if (!c.ok) {
    if (c.reason === 'already-dispatched') {
      log(`old path already dispatched for this night by ${c.holder}; no second dispatch`);
      return { action: 'stop', reason: 'another watchdog already fell back', done: true, claimFailures: 0 };
    }
    if (c.reason === 'claim-in-flight') {
      log(`another watchdog (${c.holder}) is falling back; waiting`);
      return { action: 'wait', reason: 'fallback claimed by another watchdog', done: false, claimFailures: 0 };
    }
    claimFailures += 1;
    if (claimFailures < CLAIM_FAILURES_BEFORE_DISPATCH) {
      log(`fallback claim failed (${c.reason}); retrying next tick (${claimFailures}/${CLAIM_FAILURES_BEFORE_DISPATCH})`);
      return { action: 'wait', reason: 'fallback claim not written', done: false, claimFailures };
    }
    log(`fallback claim failed ${claimFailures} times (${c.reason}); dispatching without it`);
  }
  const dispatched = ports.dispatchOldPath();
  if (!dispatched) {
    log('old-path dispatch failed; retrying next tick');
    return { ...decision, dispatched: false, done: false, claimFailures };
  }
  if (c.ok) {
    const m = ports.claim((s) => markFallbackDispatched(s, { ...args, holder }));
    if (!m.ok) log(`could not mark the claim dispatched (${m.reason}); this chain still never dispatches again`);
  }
  if (decision.digest) ports.page(decision);
  return { ...decision, dispatched: true, done: true, claimFailures: 0 };
}

module.exports = {
  LEASE_TTL_MIN, LANE_LEAD_MIN, LANE_WINDOW_MIN, START_BEFORE_MIN, START_AFTER_MIN, WAIT_JOB_BUDGET_MIN, TICK_MIN,
  nightRunTitle, watchdogRunTitle, nightTimes, laneOnlyCovers, planNightStart, planNightWait, decideWatchdog,
  releaseDeadLease, runWatchdogTick, FALLBACK_BRANCH, CLAIM_TTL_MIN, CLAIM_STALE_MIN, CLAIM_FAILURES_BEFORE_DISPATCH,
  claimFallback, markFallbackDispatched,
};
