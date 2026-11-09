'use strict';
/**
 * press-night-poll-plan.js (BRO-6858): how long the opening-night orchestrator sleeps between poller runs.
 *
 * A poller run takes ~58 min (p50 of the last 100 runs, 2026-11-02: inline poll 15, text collection 11, rebuild 8,
 * deploy wait 8), so the orchestrator's own sleep is the only gap it controls. Inside the first 2h after a Broadway
 * show's embargo the sleep drops from 15 to 5 min; everywhere else it stays as before. An explicit
 * poll_interval_minutes input always wins. SERP: the orchestrator still sends --skip-serp on iterations 1-8, but
 * for Broadway the poller's hourly SERP sweep (BRO-4272, serp-burst-caps.js) overrides it from the first stored
 * review of the night, under the burst caps; tests/unit/press-night-poll-plan.test.mjs pins that the embargo to
 * +3h sits inside that sweep's window.
 *
 * CLI: node scripts/lib/press-night-poll-plan.js --shows=a,b [--default=15] [--override=N] [--now=ISO]
 * prints the minutes to sleep (shows from data/shows.json).
 */

const FAST_MIN = 5;
const FAST_WINDOW_MIN = 120;
const MIN = 60000;
const { isBroadwayCategory } = require('./venue-classification');

/** shows: [{id, category, embargoMs}]. Returns {intervalMin, reason}. */
function pollIntervalMin({ shows = [], nowMs, defaultMin = 15, overrideMin = null }) {
  if (Number.isFinite(overrideMin) && overrideMin > 0) return { intervalMin: overrideMin, reason: 'input override' };
  const hot = shows.find((s) => s && isBroadwayCategory(s) && Number.isFinite(s.embargoMs)
    && nowMs >= s.embargoMs && nowMs - s.embargoMs <= FAST_WINDOW_MIN * MIN);
  if (hot) return { intervalMin: Math.min(FAST_MIN, defaultMin), reason: `${hot.id} is in its first 2h after the embargo` };
  return { intervalMin: defaultMin, reason: 'default' };
}

module.exports = { pollIntervalMin, FAST_MIN, FAST_WINDOW_MIN };

if (require.main === module) {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
  const defaultMin = Number(arg('default')) || 15;
  try {
    const { defaultEmbargoAt } = require('./press-night-record'); // lane lib: required, never edited
    const raw = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../data/shows.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.shows || [];
    const ids = arg('shows').split(',').map((s) => s.trim()).filter(Boolean);
    const shows = ids.map((id) => list.find((s) => (s.id || s.slug) === id)).filter(Boolean)
      .map((s) => ({ id: s.id || s.slug, category: s.category, embargoMs: Date.parse(defaultEmbargoAt(s) || '') }));
    const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
    const r = pollIntervalMin({ shows, nowMs, defaultMin, overrideMin: Number(arg('override')) || null });
    console.error(`poll interval ${r.intervalMin} min (${r.reason})`);
    console.log(r.intervalMin);
  } catch (e) {
    console.error(`::warning::poll plan failed (${e.message}); using ${defaultMin} min`);
    console.log(defaultMin);
  }
}
