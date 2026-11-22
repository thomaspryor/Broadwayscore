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
 * Pure functions here; IO lives in scripts/audit-step-timeout-headroom.js.
 */

const { buildAuditAlert } = require('./audit-alert');

const DEFAULT_JOB_TIMEOUT_MIN = 360; // GitHub's default when a job sets none
const DEFAULT_WARN_RATIO = 0.8;
const ALERT_KEY = 'step-timeout-headroom:near-cap';

function unquote(s) {
  const t = String(s).trim().replace(/\s+#.*$/, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function minutes(v) {
  const n = Number(unquote(v));
  return Number.isFinite(n) && n > 0 ? n : null; // `${{ }}` expressions -> null (unknown cap)
}

/**
 * PURE. Job and step timeout caps from a workflow's YAML text. Line-based on
 * purpose (no YAML dependency): GitHub workflows here use 2-space job keys,
 * 4-space job fields and `      - ` step items with 8-space step fields.
 * @returns {Array<{key:string,name:string,timeoutMin:number,steps:Array<{name:string,timeoutMin:number|null}>}>}
 */
function parseWorkflowCaps(yamlText) {
  const lines = String(yamlText || '').split('\n');
  const jobs = [];
  let inJobs = false;
  let job = null;
  let step = null;
  let inSteps = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^\S/.test(line)) { inJobs = /^jobs:\s*$/.test(line); job = null; step = null; continue; }
    if (!inJobs || /^\s*#/.test(line) || !line.trim()) continue;
    let m;
    if ((m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/))) {
      job = { key: m[1], name: m[1], timeoutMin: null, steps: [] };
      jobs.push(job);
      step = null; inSteps = false;
      continue;
    }
    if (!job) continue;
    if ((m = line.match(/^ {4}([a-z-]+):\s*(.*)$/))) {
      inSteps = m[1] === 'steps';
      step = null;
      if (m[1] === 'name' && m[2]) job.name = unquote(m[2]);
      if (m[1] === 'timeout-minutes') job.timeoutMin = minutes(m[2]);
      continue;
    }
    if (!inSteps) continue;
    if ((m = line.match(/^ {6}- (?:([a-z-]+):\s*(.*))?$/))) {
      step = { name: null, timeoutMin: null };
      job.steps.push(step);
      if (m[1] === 'name') step.name = unquote(m[2]);
      if (m[1] === 'timeout-minutes') step.timeoutMin = minutes(m[2]);
      continue;
    }
    if (step && (m = line.match(/^ {8}([a-z-]+):\s*(.*)$/))) {
      if (m[1] === 'name') step.name = unquote(m[2]);
      if (m[1] === 'timeout-minutes') step.timeoutMin = minutes(m[2]);
    }
  }
  for (const j of jobs) if (j.timeoutMin === null) j.timeoutMin = DEFAULT_JOB_TIMEOUT_MIN;
  return jobs;
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

/** PURE. Rows whose slowest run used >= warnRatio of the cap, worst first. */
function nearCap(measured, warnRatio = DEFAULT_WARN_RATIO) {
  return (measured || [])
    .map((r) => ({ ...r, ratio: r.capMin ? r.maxMin / r.capMin : 0 }))
    .filter((r) => r.ratio >= warnRatio)
    .sort((a, b) => b.ratio - a.ratio);
}

function rowText(workflow, r) {
  const what = r.kind === 'job' ? `job "${r.job}"` : `step "${r.step}" (job ${r.job})`;
  return `${workflow}: ${what} took ${r.maxMin.toFixed(1)} of its ${r.capMin} min cap (${Math.round(r.ratio * 100)}%) in run ${r.worstRun && r.worstRun.runId}, ${r.samples} recent runs read`;
}

/**
 * PURE. audit-alert decisions: one worker card while any step is near its cap,
 * cleared when none is. An unreadable input returns no decision (never clears).
 * @param {{inputMissing?:boolean, findings:Array<{workflow:string}&object>, warnRatio:number}} out
 */
function decideHeadroomAlerts(out) {
  if (!out || out.inputMissing) return [];
  const rows = (out.findings || []).map((f) => rowText(f.workflow, f));
  return [buildAuditAlert({
    conditionKey: ALERT_KEY,
    rows,
    title: (n) => `Opening-night timeout headroom: ${n} step${n === 1 ? '' : 's'} near ${n === 1 ? 'its' : 'their'} timeout cap`,
    intro: `The daily headroom audit found ${rows.length} opening-night step${rows.length === 1 ? '' : 's'} whose slowest recent run used at least ${Math.round((out.warnRatio || DEFAULT_WARN_RATIO) * 100)}% of its timeout-minutes cap. They are still green; the next slow run times out and pages "Opening Night Poller Failed" (BRO-7117: 3 of 12 cases in 30 days were this).`,
    hint: 'Make the step faster or bound its work (time budget, cache, skip duplicate work), and only then raise its timeout-minutes and the job timeout to match. Do NOT dispatch opening-night-poller.yml or opening-night-broadcast.yml by hand (CLAUDE.md section 17). Done when node scripts/audit-step-timeout-headroom.js --strict exits 0.',
    resolveReason: 'every opening-night step is under its headroom threshold',
  })];
}

module.exports = {
  parseWorkflowCaps, measure, nearCap, decideHeadroomAlerts, matchJob, matchStep, namePattern, rowText,
  DEFAULT_WARN_RATIO, DEFAULT_JOB_TIMEOUT_MIN, ALERT_KEY,
};
