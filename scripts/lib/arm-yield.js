'use strict';

/**
 * arm-yield.js — cross-run "this arm produced nothing for N days" detection.
 *
 * Card #647. The 2026-07-30 pipeline health audit found three arms completely
 * dead — for 11 days, 16 days and 5 months — and none of them raised an alarm:
 *
 *   1. opening-night-orchestrator: killed at its 360min cap on every scheduled
 *      run since 2026-07-19 (166/197 cancelled). conclusion=cancelled is not
 *      failure, and `if: always()` does not fire on cancellation, so its own
 *      alerting never ran.
 *   2. sweep-we-aggregators: 8 consecutive failures from 2026-07-17, notifying
 *      at severity:low / email:false — 16 days with no owner-visible signal.
 *   3. scoring-audit: 5/5 failures since 2026-03-01 on a MONTHLY cron, so five
 *      data points in five months and none surfaced.
 *
 * Every existing zero-data guard in this repo is PER-RUN ("this run fetched
 * zero items → exit 1"). None of them can see the shape all three failures
 * actually had, which is cross-run: "this arm has produced nothing for N days".
 * A run that is cancelled, or that fails before its guard, or that only fires
 * monthly, produces no per-run signal at all — the absence IS the signal, and
 * absence is only visible by comparing across runs.
 *
 * This module is the pure decision layer over an append-only yield ledger
 * (data/audit/arm-yield-ledger.jsonl, one {arm, date, itemsFound} record per
 * arm per day). It holds no I/O so the thresholds can be unit-tested against
 * fixtures and replayed against real historical windows.
 *
 * ── Why the threshold is per-arm, seeded from the arm's own history ─────────
 * A global "N days of zero = dead" constant cannot work here. nysr (New York
 * Stage Review) legitimately went 8 consecutive days without publishing in
 * July 2026; the WE aggregator sweep produces something nearly every day. One
 * constant either pages constantly on the sparse arm or never fires on the
 * dense one. So each arm's threshold is derived from the longest gap between
 * consecutive productive days it showed while it was demonstrably alive, plus
 * a safety margin — an arm has to go quiet for longer than it has ever gone
 * quiet before to be called dead.
 *
 * ── Why gaps are measured in calendar days, not "observed zero rows" ────────
 * A missing ledger row and a row saying zero mean exactly the same thing about
 * the arm (it produced nothing that day), and the recorder can legitimately
 * miss days (its own cron can be cancelled). Deriving everything from the
 * PRODUCTIVE dates alone makes the maths identical either way, so a gap in the
 * ledger can never be mistaken for a healthy arm.
 *
 * ── Two rules, because the audit's dead arms had two different shapes ───────
 * computeArmState() = SILENCE: consecutive days producing literally nothing.
 * That is sweep-we-aggregators (16 straight days of zero) and scoring-audit.
 *
 * computeCollapseState() = COLLAPSE: still producing, but a fraction of what
 * it used to. The orchestrator's real 2026-07-13..07-30 record is not a clean
 * run of zeroes — its five daily scheduled runs went from 1-3 successes/day to
 * two successes in eighteen days, with stray single successes on 07-19 and
 * 07-30. A pure silence rule reads each of those strays as a heartbeat and
 * resets, so the outage is invisible on exactly the day the card asks us to
 * catch it. Volume over a trailing window is the only thing that sees it.
 *
 * Collapse is applied ONLY to arms declared cadence:'steady' (the workflow
 * arms). A cron fires N times a day whatever else is happening, so a volume
 * drop means something broke. Outlet arms are event-driven and legitimately
 * bursty — reviews cluster around opening nights, so a quiet fortnight after
 * a busy one is the theatre calendar, not a fault, and a collapse rule there
 * would alert on Broadway's schedule rather than on the pipeline.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  /** Trailing history used to seed the per-arm threshold, ending at the arm's last yield. */
  windowDays: 30,
  /** Floor. Nothing alerts on a 1-2 day quiet spell, however dense the arm. */
  minStreakDays: 3,
  /** Added on top of the arm's longest observed quiet gap before calling it dead. */
  gapSafetyDays: 1,
  /** An arm needs this many productive days in its baseline window to be judged at all. */
  minProductiveDays: 3,
  /**
   * If the ledger holds nothing for an arm within this many days of asOf, the
   * DETECTOR is blind for that arm — report it rather than silently reading
   * "no rows" as "healthy". That misreading is the exact failure this whole
   * module exists to stop.
   */
  maxObservationAgeDays: 3,

  // ── Collapse rule (cadence:'steady' arms only) ────────────────────────────
  /** Trailing window whose volume is compared against the arm's demonstrated peak. */
  recentDays: 14,
  /** How far back to look for that peak. Must comfortably exceed recentDays. */
  lookbackDays: 60,
  /** Below this fraction of peak volume, the arm has collapsed. */
  collapseRatio: 0.2,
  /**
   * Arms whose peak trailing-window volume is under this never trip the
   * collapse rule: at low volumes the ratio is noise (1 item where there were
   * 2 is a "50% collapse"), and sparse arms are already covered by silence.
   */
  minPeakVolume: 7,
};

/** 'YYYY-MM-DD' → epoch ms (UTC midnight). Returns NaN for anything unparseable. */
function dayToMs(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  return Date.parse(`${day}T00:00:00Z`);
}

/** Whole calendar days from `from` to `to` (negative if `to` precedes `from`). */
function daysBetween(from, to) {
  const a = dayToMs(from);
  const b = dayToMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / MS_PER_DAY);
}

/** Date → 'YYYY-MM-DD' in UTC. */
function toDayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Today in UTC as 'YYYY-MM-DD'. */
function todayKey() {
  return toDayKey(Date.now());
}

/**
 * Fold ledger records into arm → (date → itemsFound).
 *
 * Multiple records for the same (arm, date) are SUMMED, not last-wins: a day
 * can legitimately be recorded by more than one run (e.g. a backfill pass and
 * the daily pass), and each record carries the items that pass found. Callers
 * that re-record a whole day must therefore replace, not append — see
 * dedupeEntries().
 *
 * @param {Array<{arm:string, date:string, itemsFound:number}>} entries
 * @returns {Map<string, Map<string, number>>}
 */
function indexLedger(entries) {
  const byArm = new Map();
  for (const e of entries || []) {
    if (!e || typeof e.arm !== 'string' || !Number.isFinite(dayToMs(e.date))) continue;
    const items = Number(e.itemsFound);
    if (!Number.isFinite(items) || items < 0) continue;
    if (!byArm.has(e.arm)) byArm.set(e.arm, new Map());
    const days = byArm.get(e.arm);
    days.set(e.date, (days.get(e.date) || 0) + items);
  }
  return byArm;
}

/**
 * Collapse duplicate (arm, date) records to the LAST one written, so a re-run
 * that re-records a day replaces it instead of doubling it. Order-preserving
 * on first appearance so the ledger stays readable.
 *
 * @param {Array<{arm:string, date:string, itemsFound:number}>} entries
 * @returns {Array<object>}
 */
function dedupeEntries(entries) {
  const byKey = new Map();
  for (const e of entries || []) {
    if (!e || typeof e.arm !== 'string' || !Number.isFinite(dayToMs(e.date))) continue;
    // Key on arm + date with a NUL separator, written as an ESCAPE: a literal
    // NUL in the source makes git classify the whole file as binary (no diffs,
    // no reviewable history). It can never collide with an arm id or a date.
    byKey.set(`${e.arm}\u0000${e.date}`, e);
  }
  return [...byKey.values()].sort((a, b) =>
    a.date === b.date ? a.arm.localeCompare(b.arm) : a.date.localeCompare(b.date)
  );
}

/**
 * Judge one arm from its daily yield history.
 *
 * @param {Map<string, number>|Object<string, number>} dailyCounts date → itemsFound
 * @param {object} [opts] overrides for DEFAULTS, plus `asOf` ('YYYY-MM-DD')
 * @returns {{
 *   verdict: 'dead'|'healthy'|'insufficient-history'|'no-history'|'unobserved',
 *   reason: string,
 *   lastYieldDate: string|null,
 *   daysSinceLastYield: number|null,
 *   threshold: number|null,
 *   longestPriorGap: number|null,
 *   productiveDays: number,
 *   windowItems: number,
 *   baselineWindow: {from: string, to: string}|null,
 *   lastObservedDate: string|null,
 * }}
 */
function computeArmState(dailyCounts, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const asOf = cfg.asOf || todayKey();

  const map = dailyCounts instanceof Map ? dailyCounts : new Map(Object.entries(dailyCounts || {}));
  const dates = [...map.keys()]
    .filter((d) => Number.isFinite(dayToMs(d)) && d <= asOf)
    .sort();

  const base = {
    verdict: 'no-history',
    reason: 'no ledger rows for this arm',
    lastYieldDate: null,
    daysSinceLastYield: null,
    threshold: null,
    longestPriorGap: null,
    productiveDays: 0,
    windowItems: 0,
    baselineWindow: null,
    lastObservedDate: null,
  };

  if (dates.length === 0) return base;

  const lastObservedDate = dates[dates.length - 1];
  base.lastObservedDate = lastObservedDate;

  // The detector is blind for this arm — say so instead of reading silence as
  // health. A recorder that stops writing looks exactly like a healthy arm to
  // any check that only asks "was the last row a zero?".
  const observationAge = daysBetween(lastObservedDate, asOf);
  if (observationAge > cfg.maxObservationAgeDays) {
    return {
      ...base,
      verdict: 'unobserved',
      reason: `no ledger row for ${observationAge}d (last ${lastObservedDate}, max ${cfg.maxObservationAgeDays}d) — the recorder, not the arm, may be dead`,
    };
  }

  const productive = dates.filter((d) => (map.get(d) || 0) > 0);
  if (productive.length === 0) {
    // Nothing productive anywhere in the retained ledger. Two very different
    // situations share that shape, and collapsing them is how the longest-dead
    // arm ends up being the one nobody hears about:
    //   · a newly registered arm with a few days of rows — genuinely unjudgeable
    //   · an arm dead LONGER than the ledger goes back — scoring-audit, 5/5
    //     monthly failures since 2026-03-01. "No baseline to compare against"
    //     is not a reason to stay quiet about that one; it IS the finding.
    const observedSpan = daysBetween(dates[0], asOf);
    if (observedSpan >= cfg.windowDays) {
      return {
        ...base,
        verdict: 'dead',
        daysSinceLastYield: observedSpan,
        threshold: cfg.windowDays,
        reason: `nothing produced across the entire ${observedSpan}d retained ledger (from ${dates[0]}) — dead longer than the ledger goes back`,
        baselineWindow: { from: dates[0], to: lastObservedDate },
      };
    }
    return {
      ...base,
      verdict: 'no-history',
      reason: `arm has never recorded a productive day, and only ${observedSpan}d of ledger exist (need ${cfg.windowDays}d before calling it dead)`,
    };
  }

  const lastYieldDate = productive[productive.length - 1];
  const daysSinceLastYield = daysBetween(lastYieldDate, asOf);

  // Baseline window ends at the arm's LAST YIELD, not at asOf: for an arm dead
  // five months (scoring-audit), a window anchored on today contains nothing
  // but the outage and would conclude "no history, can't judge" — which is how
  // the longest-dead arm would be the one that alerts least.
  const fixedWindowFrom = toDayKey(dayToMs(lastYieldDate) - (cfg.windowDays - 1) * MS_PER_DAY);
  let inWindow = productive.filter((d) => d >= fixedWindowFrom && d <= lastYieldDate);
  let windowFrom = fixedWindowFrom;

  // A LOW-FREQUENCY arm has fewer than minProductiveDays productive days in any
  // 30-day window by definition — a monthly cron yields once a month. Stopping
  // at the fixed window would park every such arm on 'insufficient-history'
  // permanently, which is EXACTLY the scoring-audit failure (5/5 monthly runs
  // failed since 2026-03-01, nobody told): it would only ever be caught by the
  // dead-beyond-ledger branch above, i.e. after the outage outlives 190 days of
  // retention. So when the fixed window is too thin, widen it to span the arm's
  // last minProductiveDays yields however far back they are. The cadence is
  // still learned from the arm itself; only the lookback stretches.
  // (Codex ship-check finding, 2026-08-02 — verified: a monthly arm dead 90d
  // reported 'insufficient-history' and would never have alerted.)
  //
  // Take minProductiveDays + 1 yields, NOT minProductiveDays. The extra one is
  // load-bearing: N yields give only N-1 gaps, all of them INSIDE the recent
  // cluster, so an arm that yields rarely and then bunches (say -200, -150,
  // then -10/-9/-8) would have its 140-day approach gap discarded and get the
  // 3-day floor — reported dead on its next ordinary lull. Reaching one yield
  // further back keeps that gap in the sample. (Codex ship-check finding on the
  // first fix, 2026-08-02 — reproduced: that arm was verdict 'dead',
  // threshold 3, longestPriorGap 0.)
  if (inWindow.length < cfg.minProductiveDays && productive.length >= cfg.minProductiveDays) {
    inWindow = productive.slice(-(cfg.minProductiveDays + 1));
    windowFrom = inWindow[0];
  }

  // Gaps are measured over the in-window yields PLUS, when that sample is thin,
  // the one productive day immediately before the window. Without it, an arm
  // whose yields bunch at the end of the window has every gap measured inside
  // the bunch — the long quiet stretch leading INTO it is cut off at the window
  // edge, giving a 3-day threshold to an arm that routinely goes quiet for
  // months. (Codex ship-check finding; reproduced on an arm yielding at -200,
  // -150 then -10/-9/-8: verdict 'dead', threshold 3, longestPriorGap 0.)
  //
  // Only when thin: a dense arm has plenty of in-window gaps to characterise
  // itself, and reaching further back there would just import an old outage and
  // desensitise it.
  const gapSample = inWindow.slice();
  if (inWindow.length < cfg.minProductiveDays * 2) {
    const before = productive.filter((d) => d < gapSample[0]).pop();
    if (before) gapSample.unshift(before);
  }

  let longestPriorGap = 0;
  for (let i = 1; i < gapSample.length; i += 1) {
    const gap = daysBetween(gapSample[i - 1], gapSample[i]) - 1;
    if (gap > longestPriorGap) longestPriorGap = gap;
  }

  const windowItems = inWindow.reduce((sum, d) => sum + (map.get(d) || 0), 0);
  const threshold = Math.max(cfg.minStreakDays, longestPriorGap + 1 + cfg.gapSafetyDays);

  const state = {
    verdict: 'healthy',
    reason: '',
    lastYieldDate,
    daysSinceLastYield,
    threshold,
    longestPriorGap,
    productiveDays: inWindow.length,
    windowItems,
    baselineWindow: { from: windowFrom, to: lastYieldDate },
    lastObservedDate,
  };

  if (inWindow.length < cfg.minProductiveDays) {
    // Only reachable when the arm has never yielded minProductiveDays times at
    // all — a genuinely new arm, with no cadence to compare anything against.
    return {
      ...state,
      verdict: 'insufficient-history',
      reason: `only ${inWindow.length} productive day(s) on record (need ${cfg.minProductiveDays}) — too new to have a cadence to judge against`,
    };
  }

  if (daysSinceLastYield >= threshold) {
    return {
      ...state,
      verdict: 'dead',
      reason: `nothing produced for ${daysSinceLastYield}d (last yield ${lastYieldDate}); threshold ${threshold}d = longest quiet gap ${longestPriorGap}d + ${1 + cfg.gapSafetyDays}, floor ${cfg.minStreakDays}d`,
    };
  }

  return {
    ...state,
    reason: `last yield ${daysSinceLastYield}d ago, under the ${threshold}d threshold`,
  };
}

/** Total yield over the `days` calendar days ending at `end` (inclusive). */
function volumeInWindow(map, end, days) {
  let total = 0;
  const endMs = dayToMs(end);
  for (let i = 0; i < days; i += 1) {
    const day = toDayKey(endMs - i * MS_PER_DAY);
    total += map.get(day) || 0;
  }
  return total;
}

/**
 * Judge one STEADY-CADENCE arm on volume rather than silence.
 *
 * The orchestrator outage is the reason this exists. Its five daily scheduled
 * runs went from 1-3 successes/day (2026-07-03..07-12) to two successes across
 * eighteen days — but with stray single successes on 07-19 and 07-30, so there
 * is no long run of literal zeroes to find. computeArmState() sees a heartbeat
 * on 07-30 and calls it healthy; comparing the trailing fortnight's VOLUME
 * against the same arm's demonstrated peak sees a 90% collapse.
 *
 * "Peak" is the best `recentDays` window inside the trailing `lookbackDays` —
 * the arm's own recent proof of what it can do. A mean would be dragged down
 * by the outage itself and quietly ratify the new, broken normal.
 *
 * @param {Map<string, number>|Object<string, number>} dailyCounts
 * @param {object} [opts]
 * @returns {{verdict:'collapsed'|'healthy'|'not-applicable', reason:string,
 *            recentVolume:number, peakVolume:number, ratio:number|null,
 *            recentWindow:{from:string,to:string}}}
 */
function computeCollapseState(dailyCounts, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const asOf = cfg.asOf || todayKey();
  const map = dailyCounts instanceof Map ? dailyCounts : new Map(Object.entries(dailyCounts || {}));

  const recentVolume = volumeInWindow(map, asOf, cfg.recentDays);
  const recentFrom = toDayKey(dayToMs(asOf) - (cfg.recentDays - 1) * MS_PER_DAY);

  let peakVolume = 0;
  // Slide the recent-sized window back across the lookback period.
  for (let offset = 0; offset <= cfg.lookbackDays - cfg.recentDays; offset += 1) {
    const end = toDayKey(dayToMs(asOf) - offset * MS_PER_DAY);
    const vol = volumeInWindow(map, end, cfg.recentDays);
    if (vol > peakVolume) peakVolume = vol;
  }

  const result = {
    recentVolume,
    peakVolume,
    ratio: peakVolume > 0 ? recentVolume / peakVolume : null,
    recentWindow: { from: recentFrom, to: asOf },
  };

  if (peakVolume < cfg.minPeakVolume) {
    return {
      ...result,
      verdict: 'not-applicable',
      reason: `peak ${cfg.recentDays}d volume ${peakVolume} is under the ${cfg.minPeakVolume} floor — too sparse for a ratio to mean anything`,
    };
  }
  if (result.ratio < cfg.collapseRatio) {
    return {
      ...result,
      verdict: 'collapsed',
      reason: `produced ${recentVolume} in the last ${cfg.recentDays}d vs a peak of ${peakVolume} over the trailing ${cfg.lookbackDays}d (${Math.round(result.ratio * 100)}%, floor ${Math.round(cfg.collapseRatio * 100)}%)`,
    };
  }
  return {
    ...result,
    verdict: 'healthy',
    reason: `${recentVolume}/${peakVolume} = ${Math.round(result.ratio * 100)}% of peak, above the ${Math.round(cfg.collapseRatio * 100)}% floor`,
  };
}

/**
 * Judge every registered arm against the ledger.
 *
 * Silence is checked for every arm; collapse only for arms declared
 * cadence:'steady' (see the module header for why bursty outlet arms are
 * exempt). An arm already judged 'dead' by silence is not also reported as
 * collapsed — that would be two alerts for one outage.
 *
 * @param {Array<object>} entries raw ledger records
 * @param {Array<{id:string, label:string, cadence?:string}>} arms registry entries
 * @param {object} [opts] forwarded to computeArmState/computeCollapseState
 * @returns {{states:Array<object>, dead:Array<object>, collapsed:Array<object>, unobserved:Array<object>}}
 */
function detectDeadArms(entries, arms, opts = {}) {
  const byArm = indexLedger(entries);
  const states = (arms || []).map((arm) => {
    const days = byArm.get(arm.id) || new Map();
    const state = computeArmState(days, opts);
    const collapse =
      arm.cadence === 'steady' && state.verdict !== 'unobserved'
        ? computeCollapseState(days, opts)
        : { verdict: 'not-applicable', reason: 'collapse rule applies to steady-cadence arms only' };
    return { ...state, id: arm.id, label: arm.label || arm.id, collapse };
  });
  return {
    states,
    dead: states.filter((s) => s.verdict === 'dead'),
    collapsed: states.filter((s) => s.verdict !== 'dead' && s.collapse.verdict === 'collapsed'),
    unobserved: states.filter((s) => s.verdict === 'unobserved'),
  };
}

module.exports = {
  DEFAULTS,
  MS_PER_DAY,
  computeArmState,
  computeCollapseState,
  volumeInWindow,
  daysBetween,
  dayToMs,
  dedupeEntries,
  detectDeadArms,
  indexLedger,
  toDayKey,
  todayKey,
};
