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

const { defaultEmbargoAt, embargoInfo } = require('./press-night-record.js');
const { coversShow } = require('./opening-night-lane/lane-only-markets');
const { standsDown } = require('./opening-night-lane/standdown');

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
  'scripts/opening-night-lane.js',
  'scripts/lane-auto-fallback.js',
  'scripts/lib/press-night-record.js',
  'scripts/lib/opening-night-lane',
  'scripts/llm-scoring',
  'scripts/lib/models.js',
  'scripts/lib/url-discovery.js',
  'scripts/lib/serp-second-opinion-policy.js',
  'scripts/rebuild-all-reviews.js',
  'scripts/collect-review-texts.js',
];

/** The lane's arm proof (laneCodeHash, rehearsal.js) hashes lane code reached by require(). A change under these
 * prefixes is covered by "armed"; a workflow, the poller or the rebuild is not, so those commits stay a WARN even
 * when the lane is armed. */
const ARM_COVERED_PREFIXES = ['scripts/lib/', 'scripts/llm-scoring', 'scripts/opening-night-lane.js', 'scripts/lane-auto-fallback.js'];
const armCovered = (p) => ARM_COVERED_PREFIXES.some((x) => String(p).startsWith(x));

/** Lane workflows start before the kick (the pre-wait runs a day ahead), and the clock kicks at embargo -2h. */
const KICK_LEAD_MIN = 120;
const QUEUED_STUCK_MIN = 30;
/** Dispatch delay allowed after the kick time before a missing night run is a FAIL. */
const KICK_GRACE_MIN = 20;

/**
 * LANE_ONLY_MARKETS / LANE_STANDDOWN as last written through opening-night-lane-switch.yml (data/audit/lane-switch.jsonl).
 * Cloud sessions get 403 on repo variables, so the ledger is the readable record. A variable never written there reads
 * as unset. entries: parsed ledger rows, oldest first.
 */
function replayLaneVars(entries) {
  const vars = {};
  for (const e of entries || []) {
    if (!e || e.mode !== 'live' || e.ok === false) continue;
    for (const c of e.changes || []) {
      if (!c || !c.variable) continue;
      if (c.op === 'delete-var' || c.op === 'clear') vars[c.variable] = '';
      else if (c.to !== undefined) vars[c.variable] = String(c.to);
    }
  }
  return { onlyMarkets: vars.LANE_ONLY_MARKETS || '', standdown: vars.LANE_STANDDOWN || '' };
}

/** Does the lane publish this show's press night? Only then are a disarmed lane or a missing night run a risk. */
function laneAppliesTo(vars, show) {
  if (!coversShow({ ok: true, value: vars.onlyMarkets }, show)) {
    return { applies: false, reason: `LANE_ONLY_MARKETS ("${vars.onlyMarkets}") does not cover this show, so the old path publishes it and the lane is not its publisher.` };
  }
  if (standsDown(vars.standdown, show)) {
    return { applies: false, reason: `LANE_STANDDOWN ("${vars.standdown}") stands the lane down for this show.` };
  }
  return { applies: true, reason: `LANE_ONLY_MARKETS ("${vars.onlyMarkets}") covers this show.` };
}

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

let _profiles;
function dropWindowFor(show) {
  try {
    const dp = require('./embargo-drop-profiles');
    if (_profiles === undefined) _profiles = dp.loadBenchProfiles();
    return dp.dropWindow(show, _profiles);
  } catch { return null; }
}

function embargoVerdict(show, nowMs) {
  const e = embargoFor(show);
  if (!e) return { status: 'warn', detail: 'No embargo could be computed for this show, so the press-night clock will not plan it.' };
  const hrs = (e.embargoMs - nowMs) / HOUR;
  const when = hrs >= 0 ? `in ${hrs.toFixed(1)}h` : `${Math.abs(hrs).toFixed(1)}h ago`;
  const kick = `the clock kicks the night at ${new Date(e.kickAtMs).toISOString()}`;
  // BRO-7740: a market-default embargo is a guess. The day before opening it is flagged so someone confirms it (reviewEmbargoAt in
  // shows.json, from the press release or office). The lane's guard covers an early release either way.
  const info = embargoInfo(show);
  // BRO-7779 item 7: what recorded nights say about the real drop, labelled observed or guess.
  const dw = dropWindowFor(show);
  const history = dw ? ` Drop history: ${dw.text}.` : '';
  if (info.assumed && hrs <= 36 && hrs > 0) {
    // BRO-7786: the same start the lane itself uses (nightTimes), so this text can never disagree with the lane.
    const af = require('./opening-night-lane/auto-fallback');
    const nt = af.nightTimes(show, show.openingDate, { preembargo: false });
    const guardFromMs = nt ? nt.laneStartMs : e.embargoMs - 90 * 60000;
    const guardFrom = new Date(guardFromMs).toISOString();
    const basisText = nt ? ` (${af.guardStartText(nt)})` : '';
    const early = dw && dw.basis === 'observed' && Date.parse(dw.fromAt) < guardFromMs
      ? ` Recorded nights dropped as early as ${dw.fromAt}, before even the guard's earliest start: a review that early is caught only after it.` : '';
    return { status: 'warn', detail: `Reviews are assumed to open ${e.embargoAt} (${when}), the market default, not a confirmed time. The lane guard (direct-only, no paid spend) opens ${guardFrom}${basisText} and closes on the first live review; confirm the real time and set reviewEmbargoAt if known. ${kick}.${history}${early}` };
  }
  return { status: 'pass', detail: `Reviews open ${e.embargoAt} (${when}${info.assumed ? ', assumed market default' : ''}); ${kick}.${history}` };
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
function laneRunVerdict(runs, { showId, night, label, kickAtMs, nowMs, mode }) {
  // The live workflow also runs mode=smoke and mode=shadow with the same show and night in the title; only the
  // production mode (night) or the watchdog counts. Without `mode` any run for the show+night matches.
  // With a mode the whole title must equal what the workflow's run-name produces (also keeps `foo` from matching
  // `foo-revival`).
  const exact = mode ? `Opening-night lane ${mode} ${showId} ${night}` : null;
  const mine = (runs || []).filter((r) => {
    const t = String((r && r.displayTitle) || '').trim();
    return exact ? t === exact : (t.includes(showId) && t.includes(night));
  });
  if (!mine.length) {
    return nowMs >= kickAtMs + KICK_GRACE_MIN * MIN
      ? { status: 'fail', detail: `No ${label} for ${showId} ${night}, and the kick time passed over ${KICK_GRACE_MIN} min ago. Dispatch opening-night-orchestrator.yml for the show (it starts the lane only while LANE_ONLY_MARKETS covers it).` }
      : { status: 'warn', detail: `No ${label} for ${showId} ${night} yet. The press-night clock starts it by embargo -2h.` };
  }
  const active = mine.find((r) => r.status && r.status !== 'completed');
  if (active) {
    // 'waiting'/'in_progress' is the lane doing its job (it waits for the night). A run stuck in 'queued' is not.
    const queuedMin = (nowMs - Date.parse(active.createdAt)) / MIN;
    if (active.status === 'queued' && queuedMin > QUEUED_STUCK_MIN) {
      return { status: 'warn', detail: `${label} has been queued for ${Math.round(queuedMin)} min (started ${active.createdAt}); it may be stuck waiting for a runner.` };
    }
    return { status: 'pass', detail: `${label} is ${active.status} (started ${active.createdAt}).` };
  }
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
  const fmt = (arr) => {
    const shown = arr.slice(0, 5).map((c) => `${String(c.sha).slice(0, 8)} ${String(c.subject).split('\n')[0].slice(0, 80)}`).join('; ');
    return shown + (arr.length > 5 ? ` (+${arr.length - 5} more)` : '');
  };
  // A commit with no recorded paths is treated as not covered by the arm proof.
  const outside = list.filter((c) => !(c.paths && c.paths.length && c.paths.every(armCovered)));
  if (armed === null || armed === undefined) {
    return { status: 'warn', detail: `${list.length} pipeline commit(s) in the last ${windowHours}h and the lane arm state could not be read, so it is unproven they were re-armed: ${fmt(list)}` };
  }
  if (armed === false) {
    return { status: 'fail', detail: `${list.length} pipeline commit(s) in the last ${windowHours}h and the lane is NOT armed: ${fmt(list)}` };
  }
  if (outside.length) {
    return { status: 'warn', detail: `${outside.length} of ${list.length} pipeline commit(s) in the last ${windowHours}h touch workflows, the poller or the rebuild, which the lane arm proof does not cover. Read them: ${fmt(outside)}` };
  }
  return { status: 'pass', detail: `${list.length} pipeline commit(s) in the last ${windowHours}h, all in lane code, and the lane is armed under the current code (arm check true): ${fmt(list)}` };
}

/** Distinct commits from several per-path API responses (each: [{sha, commit:{message, committer:{date}}}]). */
function mergeCommitResponses(responses, paths) {
  const seen = new Map();
  (responses || []).forEach((resp, idx) => {
    for (const c of Array.isArray(resp) ? resp : []) {
      if (!c || !c.sha) continue;
      const p = paths && paths[idx];
      if (seen.has(c.sha)) { if (p) seen.get(c.sha).paths.push(p); continue; }
      const msg = (c.commit && c.commit.message) || '';
      seen.set(c.sha, { sha: c.sha, subject: msg.split('\n')[0], at: (c.commit && c.commit.committer && c.commit.committer.date) || '', paths: p ? [p] : [] });
    }
  });
  return [...seen.values()];
}

module.exports = {
  PIPELINE_PATHS,
  KICK_LEAD_MIN,
  embargoFor,
  nightOver,
  embargoVerdict,
  armVerdict,
  replayLaneVars,
  laneAppliesTo,
  armCovered,
  laneRunVerdict,
  changesVerdict,
  mergeCommitResponses,
};
