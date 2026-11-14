#!/usr/bin/env node
/**
 * Aggregator health monitor (BRO-6098). Advisory: exits 0 unless --strict.
 *
 *   node scripts/audit-aggregator-health.js            # report, exit 0
 *   node scripts/audit-aggregator-health.js --strict   # exit 1 on any finding
 *   node scripts/audit-aggregator-health.js --json     # machine-readable
 *   node scripts/audit-aggregator-health.js --alert    # route findings to the owner digest (CI daily)
 *
 * Coverage needs data/aggregator-archive (private repo; CI checks it out) and is
 * skipped with a note when absent. Run history needs `gh` or a reachable GitHub
 * API and is skipped the same way. The registry-vs-workflow-file check is local
 * and always runs. Logic: scripts/lib/aggregator-health.js (tested).
 */

const fs = require('fs');
const path = require('path');
const { SOURCES, assess, conditionKey, resolvedConditionKeys, archiveSteps } = require('./lib/aggregator-health');
const { loadRuns } = require('./lib/aggregator-health-inputs');
const { isScheduledWorkflow } = require('./lib/cron-coverage');
require('./lib/cli-help').exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const ARCHIVE_DIR = path.join(ROOT, 'data', 'aggregator-archive');
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  if (!Array.isArray(shows)) throw new Error('data/shows.json has no shows array');
  return shows;
}

function loadArchives(sources, shows) {
  const idBySlug = new Map(shows.filter(s => s.slug).map(s => [s.slug, s.id])); // legacy slug-named archives
  if (!fs.existsSync(ARCHIVE_DIR)) return null;
  const out = {};
  for (const s of sources) {
    const dir = path.join(ARCHIVE_DIR, s.id);
    if (!fs.existsSync(dir)) continue; // missing folder is unknown, not 0% coverage
    out[s.id] = new Set(fs.readdirSync(dir).map(f => /^(.+)\.(html|json)$/.exec(f)).filter(Boolean).map(m => idBySlug.get(m[1]) || m[1]));
  }
  return Object.values(out).every(a => a.size === 0) ? null : out; // empty clone == absent
}

function loadScheduled(sources) {
  const out = {};
  for (const s of sources) {
    for (const wf of Object.keys(s.workflows)) {
      const p = path.join(WF_DIR, wf);
      if (fs.existsSync(p)) out[wf] = isScheduledWorkflow(fs.readFileSync(p, 'utf8'));
    }
  }
  return out;
}

/** workflow file -> { checkout, push } of data/aggregator-archive (BRO-6098). */
function loadArchiveSteps(sources, wfDir = WF_DIR) {
  const out = {};
  for (const s of sources) {
    for (const wf of Object.keys(s.workflows)) {
      const p = path.join(wfDir, wf);
      if (fs.existsSync(p)) out[wf] = archiveSteps(fs.readFileSync(p, 'utf8'));
    }
  }
  return out;
}

/**
 * Route findings to the owner digest (same router as audit-coverage-holes --alert).
 * One condition per source+kind (+workflow), resolved when the finding clears.
 * A condition resolves only when its own input (archive or run history) was
 * readable, so a partial run can never "resolve" a real problem.
 */
async function alertFindings(findings, sources, have) {
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');
  let raised = 0;
  for (const f of findings) {
    try {
      await routeAlert({ conditionKey: conditionKey(f), title: f.message, description: `${f.message}\n\nMonitor: node scripts/audit-aggregator-health.js (BRO-6098). Coverage compares the last 2 full quarters with the 4 before; workflow checks use the last 30 scheduled runs.`, severity: 'warning', disposition: 'digest', cooldownHours: 20 });
      raised++;
    } catch (err) { console.error(`[aggregator-health] alert failed for ${conditionKey(f)}: ${err.message}`); process.exitCode = 1; }
  }
  for (const k of resolvedConditionKeys(findings, sources, have)) {
    try { resolveCondition(k, { reason: 'finding cleared' }); } catch { /* nothing open */ }
  }
  return raised;
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const asJson = args.includes('--json');
  const nowArg = args.find(a => a.startsWith('--now='));
  const now = nowArg ? new Date(nowArg.slice(6)) : new Date();
  const sources = SOURCES;

  if (Number.isNaN(now.getTime())) { console.error('bad --now'); process.exit(2); }
  const shows = loadShows();
  const failedWf = [];
  const archives = loadArchives(sources, shows);
  const runs = args.includes('--no-runs') ? null : loadRuns(sources, failedWf, { repo: REPO });
  const archiveStepsByWorkflow = loadArchiveSteps(sources);
  const { findings, report } = assess({ sources, shows, archives, runs, scheduled: loadScheduled(sources), archiveStepsByWorkflow, now });
  const notes = [];
  if (!archives) notes.push('coverage skipped: data/aggregator-archive not present');
  if (!runs) notes.push('workflow history skipped: GitHub API unavailable or --no-runs');

  if (failedWf.length) notes.push(`run history unavailable for: ${failedWf.join(', ')}`);
  const result = { generatedAt: now.toISOString(), findings, notes, report };
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Aggregator health: ${findings.length} finding(s)`);
    for (const f of findings) console.log(`  [${f.kind}] ${f.message}`);
    for (const r of report) {
      if (r.retired) { console.log(`  ${r.source}: retired ${r.retired.on} (${r.retired.reason})`); continue; }
      const c = r.coverage;
      if (c && c.recent !== undefined) console.log(`  ${r.source}: coverage ${c.recent}% recent vs ${c.baseline}% baseline${c.flagged ? ' FLAGGED' : ''}`);
      else if (c) console.log(`  ${r.source}: coverage not judged (${c.reason})`);
    }
    for (const n of notes) console.log(`  note: ${n}`);
  }
  if (args.includes('--alert')) {
    console.log(`alert: ${await alertFindings(findings, sources, { archives, runs, archiveStepsByWorkflow })} finding(s) routed to the digest`);
  }
  process.exit(strict && findings.length ? 1 : process.exitCode || 0);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { loadScheduled, loadArchiveSteps };
