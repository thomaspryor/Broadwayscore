/**
 * Claude-lane claims per board-workers firing (BRO-6087). Pure: callers pass claim comments
 * ({ body, createdAt, issue: { identifier } }) so the grouping is testable without Linear.
 * Firings run at minute 47 of every second UTC hour (docs/cloud-routines/board-workers.md,
 * cron `47 *\/2 * * *`); a claim belongs to the firing whose start is the latest one at or
 * before it. Codex claims are ignored: the Claude lane's ceiling is CLAIM_CAP per firing.
 */
const { parseWorkerModel } = require('./linear-session-reporting.js');

const CLAIM_CAP = 4;
const FIRING_MS = 2 * 3600_000;
const FIRING_OFFSET_MS = 47 * 60_000;

const firingStart = (ms) => Math.floor((ms - FIRING_OFFSET_MS) / FIRING_MS) * FIRING_MS + FIRING_OFFSET_MS;

/**
 * -> { firings, claims, avg, dist, early, ratio }. `firings` counts firings in the window that
 * claimed at least one Claude-lane card (a firing with none is invisible in claim comments);
 * `early` counts firings under the cap whose last claim came 60+ minutes before the firing's
 * 2h window closed, i.e. the lane stopped with time left (empty pick or a turn ended early).
 * Partial firings at either window edge are dropped. A session that overruns its 2h slot (land
 * waiters run up to ~95 min) has its later claims bucketed into the next firing; that lowers avg.
 */
function firingStats(comments, { nowMs = Date.now(), windowHours = 72 } = {}) {
  const sinceMs = nowMs - windowHours * 3600_000;
  const byFiring = new Map();
  const seen = new Set();
  for (const c of comments || []) {
    const key = c && (c.id || `${c.createdAt}|${c.issue && c.issue.identifier}`);
    if (key && seen.has(key)) continue; // a body with two model lines is fetched by both queries
    if (key) seen.add(key);
    const model = parseWorkerModel(c && c.body);
    const t = Date.parse(c && c.createdAt);
    if ((model !== 'sonnet' && model !== 'opus') || !Number.isFinite(t) || t < sinceMs || t > nowMs) continue;
    const s = firingStart(t);
    if (!byFiring.has(s)) byFiring.set(s, []);
    byFiring.get(s).push(t);
  }
  const dist = {};
  let claims = 0;
  let early = 0;
  for (const [s, ts] of byFiring) {
    // The firing cut by the window start or still running at nowMs is partial: counting it
    // would drag avg down and early up for reasons that are not the lane stopping.
    if (s < sinceMs || s + FIRING_MS > nowMs) { byFiring.delete(s); continue; }
    claims += ts.length;
    dist[ts.length] = (dist[ts.length] || 0) + 1;
    if (ts.length < CLAIM_CAP && s + FIRING_MS - Math.max(...ts) > 60 * 60_000) early += 1;
  }
  const firings = byFiring.size;
  return { firings, claims, avg: firings ? claims / firings : 0, dist, early, ratio: firings ? early / firings : 0 };
}

module.exports = { firingStats, firingStart, CLAIM_CAP };
