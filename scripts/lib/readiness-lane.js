'use strict';

// Pure decisions behind the lane checks in scripts/check-opening-night-readiness.js (BRO-7548).
//
// Why: on the Downstate pre-night check (2026-11-15) the readiness check said "MOSTLY READY" while knowing nothing
// about the opening-night lane, which is the primary publisher for Broadway (LANE_ONLY_MARKETS=broadway). It only
// looked at the old orchestrator path. A disarmed lane, a dead lane night run or watchdog, or a scorer/search change
// landing hours before embargo would all have read as ready. The embargo time and the recent pipeline changes had
// to be gathered by hand across 25+ calls. These functions turn each of those into a PASS / WARN / FAIL line.
//
// Statuses are the strings the readiness script prints: 'pass' | 'warn' | 'fail' | 'skip'.

const { defaultEmbargoAt } = require('./press-night-record.js');

const MIN = 60000;
const HOUR = 60 * MIN;

/** Paths whose change can alter what a press night publishes or how fast. Files and directories (the GitHub commits
 * API filters by exact path or directory prefix, not globs). */
const PIPELINE_PATHS = [
  '.github/workflows/opening-night-orchestrator.yml',
  '.github/workflows/opening-night-poller.yml',
  '.github/workflows/opening-night-lane-live.yml',
  '.github/workflows/opening-night-lane-watchdog.yml',
  '.github/workflows/opening-night-express.yml',
  '.github/workflows/press-night-clock.yml',
  '.github/workflows/aggregator-url-watcher.yml',
  'scripts/opening-night-poller.js',
  'scripts/lib/opening-night-lane',
  'scripts/llm-scoring',
  'scripts/lib/models.js',
  'scripts/lib/url-discovery.js',
  'scripts/lib/serp-second-opinion-policy.js',
  'scripts/rebuild-all-reviews.js',
  'scripts/collect-review-texts.js',
];

/** Lane workflows start before the kick (the pre-wait runs a day ahead), and the clock kicks at embargo -2h. */
const KICK_LEAD_MIN = 120;

/** When the press-night clock starts the night for this show, and when reviews open. Null when the show has no
 * computable embargo (no opening date, or a category the clock does not plan). */
function embargoFor(show) {
  if (!show || !show.openingDate) return null;
  const embargoAt = defaultEmbargoAt(show);
  const embMs = Date.parse(embargoAt);
  if (!embargoAt || !Number.isFinite(embMs)) return null;
  return { embargoAt, embargoMs: embMs, kickAtMs: embMs - KICK_LEAD_MIN * MIN };
}

/** The lane night run ends about embargo +4h (+3h with the pre-embargo window); past +12h the night is over and a
 * missing run is history, not a risk. */
const NIGHT_OVER_AFTER_H = 12;
function nightOver(show, nowMs) {
  const e = embargoFor(show);
  return !!e && nowMs > e.embargoMs + NIGHT_OVER_AFTER_H * HOUR;
}

function embargoVerdict(show, nowMs) {
  const e = embargoFor(show);
  if (!e) return { status: 'warn', detail: 'No embargo could be computed for this show, so the press-night clock will not plan it.' };
  const hrs = (e.embargoMs - nowMs) / HOUR;
  const when = hrs >= 0 ? `in ${hrs.toFixed(1)}h` : `${Math.abs(hrs).toFixed(1)}h ago`;
  return { status: 'pass', detail: `Reviews open ${e.embargoAt} (${when}); the clock kicks the night at ${new Date(e.kickAtMs).toISOString()}.` };
}

/** `node scripts/opening-night-lane-rehearse.js --arm-check` prints {"arm":bool,"reason":str}. */
function armVerdict(armJson) {
  if (!armJson || typeof armJson.arm !== 'boolean') {
    return { status: 'warn', detail: 'Could not read the lane arm check (no parseable result).' };
  }
  return armJson.arm
    ? { status: 'pass', detail: `Lane armed (${armJson.reason || 'ok'}).` }
    : { status: 'fail', detail: `Lane NOT armed: ${armJson.reason || 'no reason given'}. Re-run the rehearsal (lane-rehearsal-recorded.yml) before the night.` };
}

/**
 * One lane workflow (night run or watchdog) for this show and night.
 * runs: [{displayTitle, status, conclusion, createdAt}] newest first, as the Actions API returns them.
 * A run title carries "<showId> <night>" (e.g. "Opening-night lane night downstate-2026 2026-11-15").
 */
function laneRunVerdict(runs, { showId, night, label, kickAtMs, nowMs }) {
  const mine = (runs || []).filter((r) => {
    const t = String((r && r.displayTitle) || '');
    return t.includes(showId) && t.includes(night);
  });
  if (!mine.length) {
    return nowMs >= kickAtMs
      ? { status: 'fail', detail: `No ${label} for ${showId} ${night}, and the kick time has passed. Dispatch it (opening-night-orchestrator.yml for the show).` }
      : { status: 'warn', detail: `No ${label} for ${showId} ${night} yet. The press-night clock starts it by embargo -2h.` };
  }
  const active = mine.find((r) => r.status && r.status !== 'completed');
  if (active) return { status: 'pass', detail: `${label} is ${active.status} (started ${active.createdAt}).` };
  const latest = mine[0];
  if (latest.conclusion === 'success') return { status: 'pass', detail: `${label} finished green (${latest.createdAt}) and nothing newer is waiting.` };
  // A failed or cancelled run with nothing active behind it: nothing is watching the night.
  return { status: 'fail', detail: `${label} ended ${latest.conclusion || 'unknown'} (${latest.createdAt}) and nothing is active for ${showId} ${night}.` };
}

/**
 * Pipeline commits since the window start. The lane was re-armed by its rehearsal after code changes (the arm check
 * is what proves it), so a change is only a problem when the lane is NOT armed. Listing them answers "did anything
 * change since the last press night".
 * commits: [{sha, subject, at, files?}]
 */
function changesVerdict(commits, { armed, windowHours }) {
  const list = (commits || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!list.length) return { status: 'pass', detail: `No press-night pipeline code changed in the last ${windowHours}h.` };
  const shown = list.slice(0, 5).map((c) => `${String(c.sha).slice(0, 8)} ${String(c.subject).split('\n')[0].slice(0, 80)}`).join('; ');
  const more = list.length > 5 ? ` (+${list.length - 5} more)` : '';
  if (armed === false) {
    return { status: 'fail', detail: `${list.length} pipeline commit(s) in the last ${windowHours}h and the lane is NOT armed: ${shown}${more}` };
  }
  return { status: 'pass', detail: `${list.length} pipeline commit(s) in the last ${windowHours}h, lane re-armed after them (arm check true): ${shown}${more}` };
}

/** Distinct commits from several per-path API responses (each: [{sha, commit:{message, committer:{date}}}]). */
function mergeCommitResponses(responses) {
  const seen = new Map();
  for (const resp of responses || []) {
    for (const c of Array.isArray(resp) ? resp : []) {
      if (!c || !c.sha || seen.has(c.sha)) continue;
      const msg = (c.commit && c.commit.message) || '';
      seen.set(c.sha, { sha: c.sha, subject: msg.split('\n')[0], at: (c.commit && c.commit.committer && c.commit.committer.date) || '' });
    }
  }
  return [...seen.values()];
}

module.exports = {
  PIPELINE_PATHS,
  KICK_LEAD_MIN,
  embargoFor,
  nightOver,
  embargoVerdict,
  armVerdict,
  laneRunVerdict,
  changesVerdict,
  mergeCommitResponses,
};
