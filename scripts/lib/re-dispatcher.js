'use strict';

/**
 * re-dispatcher — pure decisions for scripts/cron-redispatch.js (BRO-4282).
 *
 * GitHub drops most of this repo's scheduled runs: on 2026-10-11/12 the
 * `*\/5` crons (vercel-deploy, demo-alias-watchdog) started 4-5 scheduled runs
 * a day, `*\/15` main-infra-rerun 3, hourly audit-aggregator-gap 4. Events
 * (push, workflow_run) are delivered reliably. check-cron-health.yml only
 * notices once a day (its own noon cron starts 15:30-20:00) and keys on the
 * last SUCCESS, so a dropped schedule waited up to a day for its one-shot
 * self-heal.
 *
 * This module is the registry-driven half: for every CRITICAL_CRONS entry in
 * check-cron-health.yml (the one registry of crons whose staleness matters),
 * dispatch the workflow when NO run of ANY event or status has been CREATED
 * within its band. A failing run counts as a run here on purpose: failures are
 * check-cron-health's job (it redispatches and pages); this only replaces runs
 * GitHub never created. The dispatched run itself resets the clock, so each
 * workflow gets at most one re-dispatch per band.
 *
 * OPT-IN, never opt-out: many critical crons branch on github.event_name or
 * github.event.schedule (alerts filed only on schedule, a full-corpus sweep on
 * a no-input dispatch, ...), so a plain dispatch is NOT a stand-in for their
 * scheduled run. A workflow joins by declaring a `redispatched` workflow_dispatch
 * input and making a run with redispatched=true behave like its scheduled run
 * (and be safe to repeat: check-cron-health's self-heal can still dispatch it
 * once more while this one is in flight). Optional `# redispatch-after-hours: N`
 * sets a tighter band than the paging band (never looser).
 */

// Same entry grammar as audit-cron-health-coverage.js and check-cron-health.yml:
// "file.yml|max_hours|Friendly Name[|active_months]".
const ENTRY_RE = /"([a-z0-9-]+\.yml)\|(\d+)\|([^"|]+)(?:\|(\d+)-(\d+))?"/g;

const REDISPATCHED_INPUT_RE = /^\s+redispatched\s*:\s*$/m;
const AFTER_HOURS_RE = /^\s*#\s*redispatch-after-hours:\s*(\d+(?:\.\d+)?)\b/m;

const DEFAULT_MAX_PER_SWEEP = 3;
// The sweep runs on every main Test Suite completion (~100/day); at most one
// sweep per fixed window of this many minutes.
const DEFAULT_SWEEP_BUCKET_MIN = 30;

// Entries with their bands and seasons (automation-freeze.js parseCriticalCrons
// returns only the file names).
function parseCriticalCronEntries(checkCronHealthYaml) {
  const out = [];
  // Comment lines can quote example entries; only live array lines count.
  const body = String(checkCronHealthYaml || '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  for (const m of body.matchAll(ENTRY_RE)) {
    out.push({
      workflow: m[1],
      maxHours: Number(m[2]),
      name: m[3].trim(),
      months: m[4] ? [Number(m[4]), Number(m[5])] : null,
    });
  }
  return out;
}

function hasDispatchTrigger(yamlText) {
  return /^\s*workflow_dispatch\s*:/m.test(String(yamlText || ''));
}

// True when the workflow declares the `redispatched` dispatch input (opt-in).
function acceptsRedispatch(yamlText) {
  const y = String(yamlText || '');
  return hasDispatchTrigger(y) && REDISPATCHED_INPUT_RE.test(y);
}

// Band for re-dispatch: the paging band, or a tighter declared one.
function redispatchBandHours(yamlText, maxHours) {
  const m = String(yamlText || '').match(AFTER_HOURS_RE);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < maxHours ? n : maxHours;
}

function inSeason(months, month) {
  if (!months) return true;
  return month >= months[0] && month <= months[1];
}

/**
 * @param {object} o
 * @param {Array<{workflow,maxHours,name,months}>} o.entries
 * @param {Record<string,{lastCreatedAt:string|null, error?:boolean}>} o.lastRuns  keyed by workflow file
 * @param {Record<string,string>} o.workflowYaml  file -> text (missing = workflow file gone)
 * @param {Record<string,string>} [o.states]  file -> GitHub workflow state ('active', 'disabled_manually', ...)
 * @param {number} [o.now]
 * @param {number} [o.maxPerSweep]
 * @returns {{dispatch: Array<{workflow,name,hoursSince,maxHours}>, skipped: Array<{workflow,name,reason}>}}
 */
function decideRedispatches({ entries, lastRuns, workflowYaml, states = {}, now = Date.now(), maxPerSweep = DEFAULT_MAX_PER_SWEEP }) {
  const month = new Date(now).getUTCMonth() + 1;
  const due = [];
  const skipped = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.workflow)) continue;
    seen.add(e.workflow);
    const skip = (reason) => skipped.push({ workflow: e.workflow, name: e.name, reason });
    const yaml = workflowYaml[e.workflow];
    if (yaml == null) { skip('workflow file missing'); continue; }
    if (!inSeason(e.months, month)) { skip('out of season'); continue; }
    if (!hasDispatchTrigger(yaml)) { skip('no workflow_dispatch trigger'); continue; }
    if (!acceptsRedispatch(yaml)) { skip('not opted in (no redispatched input)'); continue; }
    // Disabled workflows are check-cron-health's to page about; dispatching
    // one fails, and re-enabling is an owner/session decision.
    if (states[e.workflow] && states[e.workflow] !== 'active') { skip(`state ${states[e.workflow]}`); continue; }
    const r = lastRuns[e.workflow];
    // A failed query is unknown, never "stale": treating it as stale would
    // dispatch every critical cron at once on one expired token.
    if (!r || r.error) { skip('run query failed'); continue; }
    // Never ran at all: nothing to compare against; check-cron-health pages it.
    if (!r.lastCreatedAt) { skip('no runs on record'); continue; }
    const ts = Date.parse(r.lastCreatedAt);
    if (!Number.isFinite(ts)) { skip('unparseable created_at'); continue; }
    const hoursSince = (now - ts) / 3600000;
    const band = redispatchBandHours(yaml, e.maxHours);
    if (hoursSince <= band) continue;
    due.push({ workflow: e.workflow, name: e.name, hoursSince: Math.round(hoursSince * 10) / 10, maxHours: band });
  }
  // Most overdue (relative to its own band) first; cap the burst so a GitHub
  // outage that starved everything does not add a wave of runs to the queue.
  due.sort((a, b) => b.hoursSince / b.maxHours - a.hoursSince / a.maxHours);
  for (const d of due.slice(maxPerSweep)) skipped.push({ workflow: d.workflow, name: d.name, reason: `over per-sweep cap ${maxPerSweep}` });
  return { dispatch: due.slice(0, maxPerSweep), skipped };
}

/**
 * True when this run should skip its sweep. Sweeps are bucketed into fixed
 * windows of `bucketMin`: only the first run created in a bucket sweeps. Keying
 * on "the previous run was recent" instead would let a steady stream of
 * throttled runs (each one itself recent) starve every later sweep.
 */
function shouldThrottle({ prevRunCreatedAt, myCreatedAt, bucketMin = DEFAULT_SWEEP_BUCKET_MIN }) {
  if (!prevRunCreatedAt || !myCreatedAt) return false;
  const a = Date.parse(prevRunCreatedAt);
  const b = Date.parse(myCreatedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const size = bucketMin * 60000;
  return Math.floor(a / size) === Math.floor(b / size);
}

// A workflow kept alive only by re-dispatch hides a dead schedule from
// check-cron-health (it keys on last success). Flag it when its newest
// event=schedule run is older than this, or it has none.
const SCHEDULE_DEAD_DAYS = 7;
function isScheduleDead(lastScheduleCreatedAt, now = Date.now()) {
  if (!lastScheduleCreatedAt) return true;
  const t = Date.parse(lastScheduleCreatedAt);
  return !Number.isFinite(t) || now - t > SCHEDULE_DEAD_DAYS * 86400000;
}

module.exports = {
  parseCriticalCronEntries,
  hasDispatchTrigger,
  acceptsRedispatch,
  redispatchBandHours,
  isScheduleDead,
  SCHEDULE_DEAD_DAYS,
  decideRedispatches,
  shouldThrottle,
  DEFAULT_MAX_PER_SWEEP,
  DEFAULT_SWEEP_BUCKET_MIN,
};
