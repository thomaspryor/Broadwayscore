#!/usr/bin/env node
/**
 * BRO-7117: flag opening-night steps whose slowest recent run used >= 80% of
 * their timeout-minutes cap, while they are still green (logic and history:
 * scripts/lib/step-timeout-headroom.js).
 *
 *   node scripts/audit-step-timeout-headroom.js [--workflows=a.yml,b.yml] [--runs=30]
 *     [--warn-ratio=0.8] [--before=ISO] [--ref=GITREF] [--strict] [--alert] [--json=PATH]
 *
 *   --runs        completed runs read per workflow (cancelled runs skipped)
 *   --before      only runs created before this time (backtests)
 *   --ref         read the workflow YAML at this git ref instead of the work tree (backtests)
 *   --strict      exit 1 when any step is near its cap
 *   --alert       file/refresh one worker card (scripts/lib/audit-alert.js); clears it when clean
 * Exit: 0 clean/advisory, 1 near-cap under --strict, 3 input missing (API unreadable).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { fetchGitHubJSON } = require('./lib/gh-api-client');
const { parseWorkflowCaps, measure, nearCap, readIncomplete, decideHeadroomAlerts, rowText, DEFAULT_WARN_RATIO } = require('./lib/step-timeout-headroom');

const argv = process.argv.slice(2);
const flagVal = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
if (hasHelpFlag(argv)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 16).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const API = `https://api.github.com/repos/${REPO}`;
const WORKFLOWS = (flagVal('workflows') || 'opening-night-poller.yml,opening-night-express.yml,opening-night-reviews.yml').split(',').filter(Boolean);
const RUNS = Math.max(1, parseInt(flagVal('runs') || '30', 10));
const WARN = Number(flagVal('warn-ratio') || DEFAULT_WARN_RATIO);
const BEFORE = flagVal('before');
const REF = flagVal('ref');

function readYaml(wf) {
  const rel = `.github/workflows/${wf}`;
  if (REF) return execFileSync('git', ['show', `${REF}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function recentRuns(wf) {
  const created = BEFORE ? `&created=${encodeURIComponent(`<${BEFORE}`)}` : '';
  const out = [];
  for (let page = 1; out.length < RUNS && page <= 5; page++) {
    const data = await fetchGitHubJSON(`${API}/actions/workflows/${wf}/runs?status=completed&per_page=50&page=${page}${created}`, { caller: 'audit-step-timeout-headroom' });
    const list = (data && data.workflow_runs) || [];
    // A cancelled run's steps stop wherever the cancel hit: their timings say nothing about the cap.
    for (const r of list) if (r.conclusion !== 'cancelled' && r.conclusion !== 'skipped') out.push(r);
    if (list.length < 50) break;
  }
  return out.slice(0, RUNS);
}

(async () => {
  const findings = [];
  let inputMissing = false;
  let read = 0;
  for (const wf of WORKFLOWS) {
    let caps;
    try { caps = parseWorkflowCaps(readYaml(wf)); } catch (e) { console.log(`${wf}: workflow file unreadable (${e.message})`); inputMissing = true; continue; }
    let runs;
    try { runs = await recentRuns(wf); } catch (e) { console.log(`${wf}: runs unreadable (${e.message})`); inputMissing = true; continue; }
    const withJobs = [];
    for (const r of runs) {
      try {
        const j = await fetchGitHubJSON(`${API}/actions/runs/${r.id}/jobs?per_page=100`, { caller: 'audit-step-timeout-headroom' });
        withJobs.push({ runId: r.id, url: r.html_url, jobs: (j && j.jobs) || [] });
      } catch (e) { console.log(`${wf}: jobs for run ${r.id} unreadable (${e.message})`); }
    }
    read += withJobs.length;
    if (readIncomplete({ runsListed: runs.length, jobsRead: withJobs.length })) { console.log(`${wf}: only ${withJobs.length}/${runs.length} runs' timings read`); inputMissing = true; }
    const measured = measure(caps, withJobs);
    const near = nearCap(measured, WARN, wf);
    console.log(`${wf}: ${withJobs.length} runs read, ${measured.length} capped steps/jobs measured, ${near.length} at >= ${Math.round(WARN * 100)}% of cap`);
    for (const m of measured.sort((a, b) => b.maxMin / b.capMin - a.maxMin / a.capMin).slice(0, 5)) {
      console.log(`  ${(m.maxMin / m.capMin * 100).toFixed(0).padStart(3)}%  ${m.kind === 'job' ? `job ${m.job}` : m.step}  max ${m.maxMin.toFixed(1)}/${m.capMin} min`);
    }
    for (const n of near) { findings.push({ workflow: wf, ...n }); console.log(`NEAR CAP  ${rowText(wf, n)}`); }
  }
  if (!read) inputMissing = true;
  const out = { generatedAt: new Date().toISOString(), inputMissing, warnRatio: WARN, runsRead: read, findings };
  const j = flagVal('json');
  if (j) fs.writeFileSync(j, JSON.stringify(out, null, 2));
  if (argv.includes('--alert')) {
    const { routeAuditDecisions } = require('./lib/audit-alert');
    await routeAuditDecisions(decideHeadroomAlerts(out), 'audit-step-timeout-headroom');
  }
  if (inputMissing) {
    console.log(`audit-step-timeout-headroom: INPUT INCOMPLETE (${read} runs read; some workflow, run list or job timings unreadable); the card is not cleared`);
    process.exitCode = findings.length && argv.includes('--strict') ? 1 : 3;
    return;
  }
  process.exitCode = argv.includes('--strict') && findings.length ? 1 : 0;
})().catch((err) => {
  console.error(`audit-step-timeout-headroom: failed: ${err.stack || err.message}`);
  process.exitCode = 3;
});
