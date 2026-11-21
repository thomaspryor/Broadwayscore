'use strict';
// BRO-6802: the punctual press-night clock. GitHub crons fire 1-6h late, so nothing on the press-night path may wait
// for one. press-night-clock.yml is dispatch-only and sleeps until each show's kick time, then dispatches the
// orchestrator for that show (which starts the press-night probe, the lane shadow and the lane night run).
//
// Pure planning lives here so the workflow and the unit test share one implementation.
//   node scripts/lib/press-night-clock.js next --shows-file=data/shows.json [--categories=broadway,off-broadway]
//        [--fired=show:night,...] [--now=ISO]    -> prints "SHOW NIGHT KICK_ISO EMBARGO_ISO KIND" or nothing
//   node scripts/lib/press-night-clock.js sleep-plan --kick-at=ISO [--now=ISO] [--hop-budget-min=N]
//                                           -> prints "SLEEP_SECONDS kick|rechain"
//   node scripts/lib/press-night-clock.js confirm --shows-file=... --show=ID --night=DATE [--kind=K] [--categories=..] [--fired=..] [--now=ISO]
//                                           -> prints "kick" or "replan" (fresh data, same show+night+kind, due)
//   node scripts/lib/press-night-clock.js action --kind=K --category=C [--embargo-at=ISO] [--now=ISO]
//                                           -> prints "ACTION MARKET|- DEDUPE_MIN RUN_MIN" (BRO-7779)
//
// BRO-6858: besides the kick, a Broadway night has two preflight events (embargo -24h and -3h) that dispatch
// press-night-preflight.yml. Each kind has its own key (the kick keeps the bare show:night key so a chain started
// before this change carries over) and its own late bound, so a re-seed at -2h never runs the stale -24h check.

const { defaultEmbargoAt } = require('./press-night-record.js');

const MIN = 60000;
const KICK_LEAD_MIN = 120; // kick at embargo -2h: the probe window opens at -2.5h and the lane night run sleeps to -30 min itself
const KICK_LATE_MIN = 170; // still kick up to embargo +2h50 (probeDue closes at +3h)
const HORIZON_DAYS = 10;
// BRO-7779: every lane market. A show of any other category (tour, regional) has no market embargo hour, so the clock
// cannot time it; scripts/lib/press-night-coverage.js reports those as not watched.
const DEFAULT_CATEGORIES = ['broadway', 'off-broadway', 'west-end', 'off-west-end'];
const MARKET_FOR = { broadway: 'broadway', 'off-broadway': 'broadway', 'west-end': 'west-end', 'off-west-end': 'west-end' };
const ORCH_RUN_MIN = 240; // a targeted orchestrator run polls until its loop DEADLINE, start + 240 min

/**
 * Event kinds: lead (min before embargo), late (min after its own time it may still fire), categories it applies to
 * (null = every category the clock plans), dedupeMin (orchestrator kinds: skip when a targeted orchestrator run for
 * the show was created this long before the event's time).
 */
const KINDS = {
  // BRO-7779: three targeted orchestrator runs tile the night with no hole, lane or no lane:
  //   ek  embargo -4h30 .. -2h     covers lane start -3h; its loop ends when the kick starts (runMinutes), so the
  //                                two never poll side by side, and it skips the URL watcher (the kick's covers E-2h..E+2h30)
  //   kick embargo -2h  .. +2h     also starts the probe, the lane night run and the watchdog, as before
  //   tk  embargo +1h50 .. +5h50   the tail: the BRO-7740 lane ends near +185 and the first sweep is at +255
  // The sweeps (+4h15/+5h15/+6h15) carry it past +6h. tk overlaps the kick run by 10 min so a slow start is no hole.
  // dedupeMin: skip when a targeted orchestrator run for the show was created since (event time - dedupeMin). For tk
  // that is +10 min after the embargo, so the on-time kick (created at -2h) never suppresses it, while a kick that ran
  // late (created after +10, so polling past +4h10) does.
  ek: { leadMin: 270, lateMin: 110, categories: null, dedupeMin: 30 }, // until embargo -2h40, before the kick's dedupe window
  kick: { leadMin: KICK_LEAD_MIN, lateMin: KICK_LEAD_MIN + KICK_LATE_MIN, categories: null, dedupeMin: 30 },
  tk: { leadMin: -110, lateMin: 180, categories: null, dedupeMin: 100 },
  pf24: { leadMin: 24 * 60, lateMin: 20 * 60, categories: null }, // until embargo -4h
  pf3: { leadMin: 180, lateMin: 120, categories: null }, // until embargo -1h
  // BRO-7160 post-lane review sweep (scripts/lib/post-lane-sweep.js SWEEP_SLOTS/VERIFY_SLOT): after the lane releases
  // at about +4h, one targeted poller run at +4h15, +5h15 and +6h15, then a verify at +7h30. Negative lead = after
  // embargo. Each slot stays fireable until the next one is due; the last sweep and the verify until about +12h.
  sw1: { leadMin: -255, lateMin: 60, categories: null },
  sw2: { leadMin: -315, lateMin: 60, categories: null },
  sw3: { leadMin: -375, lateMin: 345, categories: null },
  swv: { leadMin: -450, lateMin: 270, categories: null },
};

/**
 * BRO-7779: what the clock workflow does when an event of `kind` comes due for a show of `category`.
 * press-night-clock.yml reads this through the `action` CLI, and scripts/lib/press-night-coverage.js builds its
 * collector timeline from it, so the coverage test and the workflow cannot disagree.
 * @returns {{action:'orchestrator'|'probe'|'preflight'|'sweep'|'none', market:string|null}}
 */
function kindAction(kind, category) {
  if (/^sw/.test(kind)) return { action: 'sweep', market: null };
  if (/^pf/.test(kind)) return { action: 'preflight', market: null };
  if ((kind === 'kick' || kind === 'ek' || kind === 'tk') && MARKET_FOR[category]) {
    return { action: 'orchestrator', market: MARKET_FOR[category] };
  }
  if (kind === 'ek' || kind === 'tk') return { action: 'none', market: null }; // only lane markets get the extra runs
  return { action: 'probe', market: null };
}

/** BRO-7779: how long a targeted orchestrator run for `kind` polls (its loop DEADLINE), dispatched at nowMs. */
function runMinutes(kind, embargoMs, nowMs) {
  if (kind !== 'ek') return ORCH_RUN_MIN;
  const toKick = Math.floor((embargoMs - KICK_LEAD_MIN * MIN - nowMs) / MIN);
  return Math.min(ORCH_RUN_MIN, Math.max(15, toKick));
}

/** BRO-7779: true when a run created at one of runStartsMs suppresses this orchestrator event (shared with the model). */
function dedupedBy(kind, kickAtMs, runStartsMs) {
  const d = (KINDS[kind] || {}).dedupeMin || 30;
  return (runStartsMs || []).some((t) => t >= kickAtMs - d * MIN && t <= kickAtMs);
}

function kickKey(showId, night, kind = 'kick') {
  return kind === 'kick' ? `${showId}:${night}` : `${showId}:${night}:${kind}`;
}

/** Every unfired kick, earliest first: [{showId, night, category, embargoAt, kickAtMs}] */
function planKicks(shows, nowMs, { categories = DEFAULT_CATEGORIES, fired = [], horizonDays = HORIZON_DAYS } = {}) {
  const done = new Set(fired);
  const out = [];
  for (const show of shows || []) {
    if (!show || !show.openingDate || !categories.includes(show.category)) continue;
    if (show.status === 'closed') continue;
    const embargoAt = defaultEmbargoAt(show);
    if (!embargoAt) continue;
    const embMs = Date.parse(embargoAt);
    if (!Number.isFinite(embMs)) continue;
    const showId = show.id || show.slug;
    for (const [kind, k] of Object.entries(KINDS)) {
      if (k.categories && !k.categories.includes(show.category)) continue;
      const kickAtMs = embMs - k.leadMin * MIN;
      if (nowMs > kickAtMs + k.lateMin * MIN) continue;
      if (kickAtMs - nowMs > horizonDays * 24 * 60 * MIN) continue;
      if (done.has(kickKey(showId, show.openingDate, kind))) continue;
      out.push({ showId, night: show.openingDate, category: show.category, embargoAt, kickAtMs, kind });
    }
  }
  return out.sort((a, b) => a.kickAtMs - b.kickAtMs || a.showId.localeCompare(b.showId) || a.kind.localeCompare(b.kind));
}

function nextKick(shows, nowMs, opts) {
  return planKicks(shows, nowMs, opts)[0] || null;
}

/** How long this run sleeps before acting: straight to the kick when it fits the budget, else one hop and re-dispatch. */
function sleepPlan(kickAtMs, nowMs, hopBudgetMin = 300) {
  const waitMs = Math.max(0, kickAtMs - nowMs);
  const hopMs = hopBudgetMin * MIN;
  if (waitMs <= hopMs) return { sleepMs: waitMs, action: 'kick' };
  return { sleepMs: hopMs, action: 'rechain' };
}

/**
 * After waking for a planned kick, replan from freshly read show data (BRO-6809: an embargo override or a closed/removed
 * show can change while the run slept). 'kick' only when the fresh plan's next kick is the same show+night and is due;
 * otherwise 'replan' (the loop recomputes and sleeps again), so a moved-later embargo never fires early.
 */
function confirmKick(shows, nowMs, planned, opts) {
  const next = nextKick(shows, nowMs, opts);
  if (!next || !planned) return 'replan';
  if (next.showId !== planned.showId || next.night !== planned.night) return 'replan';
  if (next.kind !== (planned.kind || 'kick')) return 'replan'; // BRO-6858: a preflight and the kick are different events
  return next.kickAtMs <= nowMs ? 'kick' : 'replan';
}

module.exports = { runMinutes, dedupedBy, kindAction, MARKET_FOR, ORCH_RUN_MIN, planKicks, nextKick, sleepPlan, confirmKick, kickKey, KINDS, KICK_LEAD_MIN, KICK_LATE_MIN, HORIZON_DAYS, DEFAULT_CATEGORIES };

if (require.main === module) {
  const arg = (k) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : '';
  };
  const sub = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'next';
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  if (sub === 'action') {
    const a = kindAction(arg('kind'), arg('category'));
    const emb = Date.parse(arg('embargo-at'));
    const runMin = Number.isFinite(emb) ? runMinutes(arg('kind'), emb, now) : ORCH_RUN_MIN;
    process.stdout.write(`${a.action} ${a.market || '-'} ${(KINDS[arg('kind')] || {}).dedupeMin || 30} ${runMin}\n`);
  } else if (sub === 'sleep-plan') {
    const kickAt = Date.parse(arg('kick-at'));
    if (!Number.isFinite(kickAt)) { console.error('sleep-plan needs --kick-at=ISO'); process.exit(2); }
    const p = sleepPlan(kickAt, now, arg('hop-budget-min') ? Number(arg('hop-budget-min')) : undefined);
    process.stdout.write(`${Math.ceil(p.sleepMs / 1000)} ${p.action}\n`);
  } else {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(arg('shows-file') || 'data/shows.json', 'utf8'));
    const shows = Array.isArray(raw) ? raw : raw.shows;
    const cats = (arg('categories') || DEFAULT_CATEGORIES.join(',')).split(',').filter(Boolean);
    const opts = { categories: cats, fired: arg('fired').split(',').filter(Boolean) };
    if (sub === 'confirm') {
      process.stdout.write(`${confirmKick(shows, now, { showId: arg('show'), night: arg('night'), kind: arg('kind') || 'kick' }, opts)}\n`);
    } else {
      const k = nextKick(shows, now, opts);
      if (k) process.stdout.write(`${k.showId} ${k.night} ${new Date(k.kickAtMs).toISOString()} ${k.embargoAt} ${k.kind}\n`);
    }
  }
}
