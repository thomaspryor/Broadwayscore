#!/usr/bin/env node
/**
 * Aggregator health monitor (BRO-6098). Advisory: exits 0 unless --strict.
 *
 *   node scripts/audit-aggregator-health.js            # report, exit 0
 *   node scripts/audit-aggregator-health.js --strict   # exit 1 on any finding
 *   node scripts/audit-aggregator-health.js --json     # machine-readable
 *   node scripts/audit-aggregator-health.js --write    # also write data/audit/aggregator-health.json
 *
 * Coverage needs data/aggregator-archive (private repo; CI checks it out) and is
 * skipped with a note when absent. Run history needs `gh` or a reachable GitHub
 * API and is skipped the same way. The registry-vs-workflow-file check is local
 * and always runs. Logic: scripts/lib/aggregator-health.js (tested).
 */

const fs = require('fs');
const path = require('path');
const { SOURCES, assess } = require('./lib/aggregator-health');
const { isScheduledWorkflow } = require('./lib/cron-coverage');
const { ghApiJson } = require('./lib/github-public-api');

const ROOT = path.join(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const ARCHIVE_DIR = path.join(ROOT, 'data', 'aggregator-archive');
const OUT = path.join(ROOT, 'data', 'audit', 'aggregator-health.json');
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

function loadArchives(sources) {
  if (!fs.existsSync(ARCHIVE_DIR)) return null;
  const out = {};
  for (const s of sources) {
    const dir = path.join(ARCHIVE_DIR, s.id);
    out[s.id] = new Set(fs.existsSync(dir)
      ? fs.readdirSync(dir).map(f => /^(.+)\.(html|json)$/.exec(f)).filter(Boolean).map(m => m[1])
      : []);
  }
  return out;
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

function loadRuns(sources) {
  const out = {};
  let ok = 0;
  for (const wf of new Set(sources.flatMap(s => Object.keys(s.workflows)))) {
    try {
      const body = ghApiJson(`repos/${REPO}/actions/workflows/${wf}/runs?per_page=30`);
      out[wf] = (body.workflow_runs || []).map(r => ({ created_at: r.created_at, conclusion: r.conclusion, event: r.event }));
      ok++;
    } catch { /* leave unset: that workflow is skipped, not reported healthy */ }
  }
  return ok ? out : null;
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const asJson = args.includes('--json');
  const nowArg = args.find(a => a.startsWith('--now='));
  const now = nowArg ? new Date(nowArg.slice(6)) : new Date();
  const sources = SOURCES;

  const archives = loadArchives(sources);
  const runs = args.includes('--no-runs') ? null : loadRuns(sources);
  const { findings, report } = assess({ sources, shows: loadShows(), archives, runs, scheduled: loadScheduled(sources), now });
  const notes = [];
  if (!archives) notes.push('coverage skipped: data/aggregator-archive not present');
  if (!runs) notes.push('workflow history skipped: GitHub API unavailable or --no-runs');

  const result = { generatedAt: now.toISOString(), findings, notes, report };
  if (args.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
  }
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
  process.exit(strict && findings.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { loadScheduled };
