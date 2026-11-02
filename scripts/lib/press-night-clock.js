'use strict';
// BRO-6802: the punctual press-night clock. GitHub crons fire 1-6h late, so nothing on the press-night path may wait
// for one. press-night-clock.yml is dispatch-only and sleeps until each show's kick time, then dispatches the
// orchestrator for that show (which starts the press-night probe, the lane shadow and the lane night run).
//
// Pure planning lives here so the workflow and the unit test share one implementation.
//   node scripts/lib/press-night-clock.js next --shows-file=data/shows.json [--categories=broadway,off-broadway]
//        [--fired=show:night,...] [--now=ISO]    -> prints "SHOW NIGHT KICK_ISO EMBARGO_ISO" or nothing
//   node scripts/lib/press-night-clock.js sleep-plan --kick-at=ISO [--now=ISO] [--hop-budget-min=N]
//                                           -> prints "SLEEP_SECONDS kick|rechain"
//   node scripts/lib/press-night-clock.js confirm --shows-file=... --show=ID --night=DATE [--categories=..] [--fired=..] [--now=ISO]
//                                           -> prints "kick" or "replan" (fresh data, same show+night, due)

const { defaultEmbargoAt } = require('./press-night-record.js');

const MIN = 60000;
const KICK_LEAD_MIN = 120; // kick at embargo -2h: the probe window opens at -2.5h and the lane night run sleeps to -30 min itself
const KICK_LATE_MIN = 170; // still kick up to embargo +2h50 (probeDue closes at +3h)
const HORIZON_DAYS = 10;
const DEFAULT_CATEGORIES = ['broadway'];

function kickKey(showId, night) {
  return `${showId}:${night}`;
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
    const kickAtMs = embMs - KICK_LEAD_MIN * MIN;
    if (nowMs > embMs + KICK_LATE_MIN * MIN) continue;
    if (kickAtMs - nowMs > horizonDays * 24 * 60 * MIN) continue;
    const showId = show.id || show.slug;
    if (done.has(kickKey(showId, show.openingDate))) continue;
    out.push({ showId, night: show.openingDate, category: show.category, embargoAt, kickAtMs });
  }
  return out.sort((a, b) => a.kickAtMs - b.kickAtMs || a.showId.localeCompare(b.showId));
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
  return next.kickAtMs <= nowMs ? 'kick' : 'replan';
}

module.exports = { planKicks, nextKick, sleepPlan, confirmKick, kickKey, KICK_LEAD_MIN, KICK_LATE_MIN, HORIZON_DAYS, DEFAULT_CATEGORIES };

if (require.main === module) {
  const arg = (k) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : '';
  };
  const sub = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'next';
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  if (sub === 'sleep-plan') {
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
      process.stdout.write(`${confirmKick(shows, now, { showId: arg('show'), night: arg('night') }, opts)}\n`);
    } else {
      const k = nextKick(shows, now, opts);
      if (k) process.stdout.write(`${k.showId} ${k.night} ${new Date(k.kickAtMs).toISOString()} ${k.embargoAt}\n`);
    }
  }
}
