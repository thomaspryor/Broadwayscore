'use strict';
/**
 * BRO-7117: early warning for opening-night steps that run close to their
 * timeout-minutes cap.
 *
 * "Opening Night Poller Failed" came back 12 times in 30 days. Three of those
 * were a step or the whole job running out of its timeout (BRO-5861 poll loop
 * 1h57m vs a 145-min job; BRO-6549 one hung LLM call eating a 10-min step;
 * BRO-8010/8012 readiness rebuild ~7-9 min vs a 10-min cap). Each time the
 * step had been creeping toward its cap for days in green runs, and nothing
 * looked until it went red on an opening night. This reads recent runs'
 * step timings from the GitHub API and flags any step (or job) whose slowest
 * recent run used >= warnRatio of its cap, while it is still green.
 *
 * Failed runs count: a step that already hit its cap is the clearest finding.
 * A fixed step keeps showing until its slow runs age out of the --runs window.
 * Pure functions here; IO lives in scripts/audit-step-timeout-headroom.js.
 */

const { buildAuditAlert } = require('./audit-alert');

const DEFAULT_JOB_TIMEOUT_MIN = 360; // GitHub's default when a job sets none
const DEFAULT_WARN_RATIO = 0.8;
const ALERT_KEY = 'step-timeout-headroom:near-cap';

// Steps whose own budget sits near the cap on purpose: flagged only once a run
// actually reaches the cap (ratio >= 1), not at warnRatio. Keep the reason
// pointing at the budget so a reader can re-check it when the cap moves.
const BY_DESIGN_NEAR_CAP = {
  'opening-night-poller.yml': {
    'Wait for deploy to go live (fast_path)': 'check-prod-deploy.js --wait=480 inside a 9-min cap',
    'Collect full text inline': 'MAX_DURATION_MS=540000 plus one in-flight review (~3 min) inside a 12-min cap',
  },
};

function minutes(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null; // `${{ }}` expressions -> null (unknown cap)
}

/**
 * PURE. Job and step timeout caps from a workflow's YAML text (js-yaml, the
 * parser scripts/lib/critical-workflow-notify-cancelled.js uses), so comments
 * and indentation never drop a step silently.
 * @returns {Array<{key:string,name:string,timeoutMin:number,steps:Array<{name:string|null,timeoutMin:number|null}>}>}
 */
function parseWorkflowCaps(yamlText) {
  const doc = require('js-yaml').load(String(yamlText || '')) || {};
  return Object.entries(doc.jobs || {}).map(([key, job]) => ({
    key,
    name: typeof (job && job.name) === 'string' ? job.name : key,
    timeoutMin: minutes(job && job['timeout-minutes']) || DEFAULT_JOB_TIMEOUT_MIN,
    steps: ((job && job.steps) || []).map((st) => ({
      name: typeof (st && st.name) === 'string' ? st.name : null,
      timeoutMin: minutes(st && st['timeout-minutes']),
    })),
  }));
}

function durMin(a, b) {
  const s = Date.parse(a || '');
  const e = Date.parse(b || '');
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? (e - s) / 60000 : null;
}

// A YAML name with `${{ … }}` renders per run ("Opening Night Express — ${{ inputs.show_id }}"
// shows up as "Opening Night Express — wanted-2026"): each expression matches any text.
function namePattern(name) {
  const parts = String(name).split(/\$\{\{[\s\S]*?\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}(?: \\(.*\\))?$`);
}

// API job names are the YAML `name:` (or key), plus " (matrix…)" for matrix legs.
function matchJob(caps, apiName) {
  const n = String(apiName || '');
  return caps.find((j) => j.name === n || j.key === n)
    || caps.find((j) => namePattern(j.name).test(n) || namePattern(j.key).test(n))
    || null;
}

function matchStep(steps, apiName) {
  const n = String(apiName || '');
  return steps.find((x) => x.name && x.name === n)
    || steps.find((x) => x.name && x.name.includes('${{') && namePattern(x.name).test(n))
    || null;
}

/**
 * PURE. Slowest observed duration per capped step and per job across runs.
 * @param {Array} caps parseWorkflowCaps() output
 * @param {Array<{runId:number,url?:string,jobs:Array}>} runs each with the API's jobs[] (name, started_at, completed_at, steps[])
 * @returns {Array<{kind:'job'|'step',job:string,step:string|null,capMin:number,maxMin:number,samples:number,worstRun:object}>}
 */
function measure(caps, runs) {
  const acc = new Map();
  const bump = (k, base, d, run) => {
    if (d === null) return;
    const cur = acc.get(k) || { ...base, maxMin: 0, samples: 0, worstRun: null };
    cur.samples += 1;
    if (d > cur.maxMin) { cur.maxMin = d; cur.worstRun = { runId: run.runId, url: run.url || null }; }
    acc.set(k, cur);
  };
  for (const run of runs || []) {
    for (const j of run.jobs || []) {
      const cap = matchJob(caps, j.name);
      if (!cap) continue;
      bump(`job:${cap.key}`, { kind: 'job', job: cap.key, step: null, capMin: cap.timeoutMin }, durMin(j.started_at, j.completed_at), run);
      for (const s of j.steps || []) {
        if (s.conclusion === 'skipped') continue;
        const sc = matchStep(cap.steps, s.name);
        if (!sc || sc.timeoutMin === null) continue;
        bump(`step:${cap.key}:${sc.name}`, { kind: 'step', job: cap.key, step: sc.name, capMin: sc.timeoutMin }, durMin(s.started_at, s.completed_at), run);
      }
    }
  }
  return [...acc.values()];
}

/**
 * PURE. Rows whose slowest run used >= warnRatio of the cap (>= 1 for a
 * BY_DESIGN_NEAR_CAP step of `workflow`), worst first.
 */
function nearCap(measured, warnRatio = DEFAULT_WARN_RATIO, workflow = null, byDesign = BY_DESIGN_NEAR_CAP) {
  const designed = (workflow && byDesign[workflow]) || {};
  return (measured || [])
    .map((r) => ({ ...r, ratio: r.capMin ? r.maxMin / r.capMin : 0 }))
    .filter((r) => r.ratio >= (r.kind === 'step' && designed[r.step] ? 1 : warnRatio))
    .sort((a, b) => b.ratio - a.ratio);
}

/** PURE. Too little run data to call a workflow clean: no runs, or > 10% of job reads failed. */
function readIncomplete({ runsListed, jobsRead }) {
  if (!jobsRead) return true;
  return runsListed - jobsRead > Math.floor(runsListed * 0.1);
}

function rowText(workflow, r) {
  const what = r.kind === 'job' ? `job "${r.job}"` : `step "${r.step}" (job ${r.job})`;
  return `${workflow}: ${what} took ${r.maxMin.toFixed(1)} of its ${r.capMin} min cap (${Math.round(r.ratio * 100)}%) in run ${r.worstRun && r.worstRun.runId}, ${r.samples} recent runs read`;
}

/**
 * PURE. audit-alert decisions: one worker card while any step is near its cap,
 * cleared when none is. An unreadable input returns no decision (never clears).
 * @param {{inputMissing?:boolean, findings:Array<{workflow:string}&object>, warnRatio:number}} out inputMissing = any workflow, run list or run's jobs unreadable
 */
function decideHeadroomAlerts(out) {
  if (!out) return [];
  const rows = (out.findings || []).map((f) => rowText(f.workflow, f));
  // Some run data unreadable: a finding still files, but "clean" is unproven, so never clear the card.
  if (out.inputMissing && !rows.length) return [];
  return [buildAuditAlert({
    conditionKey: ALERT_KEY,
    rows,
    title: (n) => `Opening-night timeout headroom: ${n} step${n === 1 ? '' : 's'} near ${n === 1 ? 'its' : 'their'} timeout cap`,
    intro: `The daily headroom audit found ${rows.length} opening-night step${rows.length === 1 ? '' : 's'} whose slowest recent run (green or failed) used at least ${Math.round((out.warnRatio || DEFAULT_WARN_RATIO) * 100)}% of its timeout-minutes cap. A step over 100% already hit its cap; the others are one slow run away, and a timeout pages "Opening Night Poller Failed" (BRO-7117: 3 of 12 cases in 30 days were this).`,
    hint: 'Make the step faster or bound its work (time budget, cache, skip duplicate work), and only then raise its timeout-minutes and the job timeout to match. Do NOT dispatch opening-night-poller.yml or opening-night-broadcast.yml by hand (CLAUDE.md section 17). Done when node scripts/audit-step-timeout-headroom.js --strict exits 0.',
    resolveReason: 'every opening-night step is under its headroom threshold',
  })];
}

module.exports = {
  parseWorkflowCaps, measure, nearCap, readIncomplete, BY_DESIGN_NEAR_CAP, decideHeadroomAlerts, matchJob, matchStep, namePattern, rowText,
  DEFAULT_WARN_RATIO, DEFAULT_JOB_TIMEOUT_MIN, ALERT_KEY,
};
