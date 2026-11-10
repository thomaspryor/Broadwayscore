'use strict';
/**
 * poller-dispatch-plan.js (BRO-7198): which opening-night-poller runs the orchestrator dispatches AND WAITS ON.
 *
 * 2026-11-10 (Blueberries): with more than one show selected the orchestrator dispatched only the
 * auto-discovery poller (shared concurrency group, 50-110 min) and waited on it, so the show in its
 * opening window got no poll for ~2h (targeted show_id polls take 4-6 min). Time Out's review, published
 * 05:16Z, went live ~06:10Z.
 *
 * Plan: when several shows are selected and at least one is inside its opening window, the orchestrator
 * keeps dispatching the guarded auto run (full coverage, NOT waited on) and ALSO dispatches a targeted
 * show_id run for the hottest in-window shows (at most MAX_TARGETED, waited on). The loop then runs to the
 * wall-clock deadline instead of an iteration count (see orchestrator). Kill switch: disabled=true
 * (repo var POLLER_PER_SHOW_DISABLED) restores the old behaviour exactly ('legacy').
 *
 * CLI: node scripts/lib/poller-dispatch-plan.js --shows=a,b [--disabled=true] [--now=ISO]
 * prints `mode=<legacy|parallel>`, `targeted=<id,id>` and `reason=<text>` lines (shows from data/shows.json).
 */

const MIN = 60000;
const WINDOW_BEFORE_MIN = 60;
const WINDOW_AFTER_MIN = 420;
const MAX_TARGETED = 2;

/** shows: [{id, embargoMs}]. Returns {mode:'legacy'|'parallel', targetedIds:[], reason}. */
function planPollerDispatch({ shows = [], nowMs, disabled = false, maxTargeted = MAX_TARGETED } = {}) {
  const list = (shows || []).filter((s) => s && s.id);
  if (disabled) return { mode: 'legacy', targetedIds: [], reason: 'POLLER_PER_SHOW_DISABLED' };
  if (list.length <= 1) return { mode: 'legacy', targetedIds: [], reason: 'one show or none: targeted dispatch already used' };
  const hot = list
    .filter((s) => Number.isFinite(s.embargoMs)
      && nowMs >= s.embargoMs - WINDOW_BEFORE_MIN * MIN && nowMs <= s.embargoMs + WINDOW_AFTER_MIN * MIN)
    .sort((a, b) => Math.abs(nowMs - a.embargoMs) - Math.abs(nowMs - b.embargoMs) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, maxTargeted));
  if (!hot.length) return { mode: 'legacy', targetedIds: [], reason: 'no selected show is inside its opening window' };
  return { mode: 'parallel', targetedIds: hot.map((s) => s.id), reason: `in window: ${hot.map((s) => s.id).join(',')}` };
}

module.exports = { planPollerDispatch, MAX_TARGETED, WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN };

if (require.main === module) {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
  const out = (p) => { console.log(`mode=${p.mode}`); console.log(`targeted=${p.targetedIds.join(',')}`); console.log(`reason=${p.reason}`); };
  try {
    const { defaultEmbargoAt } = require('./press-night-record'); // lane lib: required, never edited
    const raw = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../data/shows.json'), 'utf8'));
    const all = Array.isArray(raw) ? raw : raw.shows || [];
    const ids = arg('shows').split(',').map((s) => s.trim()).filter(Boolean);
    const shows = ids.map((id) => {
      const s = all.find((x) => (x.id || x.slug) === id);
      return { id, embargoMs: s ? Date.parse(defaultEmbargoAt(s) || '') : NaN };
    });
    const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
    out(planPollerDispatch({ shows, nowMs, disabled: arg('disabled') === 'true' }));
  } catch (e) {
    console.error(`::warning::poller dispatch plan failed (${e.message}); using legacy dispatch`);
    out({ mode: 'legacy', targetedIds: [], reason: `plan error: ${e.message}` });
  }
}
