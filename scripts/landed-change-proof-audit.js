#!/usr/bin/env node
// BRO-7790: daily landed-change proof audit (CLI). Pure logic + verdict meanings: scripts/lib/landed-change-proof.mjs.
//
// Usage:
//   node scripts/landed-change-proof-audit.js [--date=YYYY-MM-DD] [--days=3] [--dry-run] [--json] [--no-safe-run]
//   --date      audit day (default: today UTC). Replays use runs created before <date>T09:00Z (when the cron lands).
//   --days      window of landed days before the audit day (default 3: D-1..D-3)
//   --dry-run   print only: no ledger write, no Linear card, no safe runs (prints what it would run)
//   --sha=a,b   only these commits (prefixes); with --expect-proven exits 1 unless each is proven/deployed/waiting
//
// Evidence comes from git (origin/main), the Actions runs API (per workflow, so no 1000-row cap is hit silently:
// an incomplete list makes the commit 'unknown', never 'not_run'), and Vercel via check-prod-deploy.js --json.
// Writes: data/audit/landed-change-proof.jsonl (append-only), and ONE Linear card per day for misses (comment on the
// open "Landed changes without run proof" card when one exists).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Local runs: read VERCEL_TOKEN from .env (CI passes it via env). Only keys not already set; nothing printed.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(VERCEL_TOKEN)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env */ }
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const CARD_TITLE = 'Landed changes without run proof';

function arg(name, dflt = null) {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return dflt;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
}
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function readCommits(since, until) {
  const out = git(['log', 'origin/main', '--no-merges', `--since=${since}`, `--until=${until}`, '--format=%x1e%H%x1f%cI%x1f%an%x1f%ae%x1f%s%x1f%B%x1f', '--name-only']);
  return out.split('\x1e').filter((c) => c.trim()).map((c) => {
    const [sha, landedAt, authorName, authorEmail, subject, body, rest] = c.split('\x1f');
    return { sha, landedAt: new Date(landedAt).toISOString(), authorName, authorEmail, subject, body, files: String(rest || '').split('\n').map((s) => s.trim()).filter(Boolean) };
  });
}

function positions(since) {
  const shas = git(['rev-list', '--first-parent', 'origin/main', `--since=${since}`]).split('\n').filter(Boolean).reverse();
  return new Map(shas.map((s, i) => [s, i]));
}

function ghJson(url) {
  return JSON.parse(execFileSync('gh', ['api', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** Completed runs of one workflow created in [start, end). -> { runs, complete } */
function workflowRuns(wf, start, end, depth = 0) {
  const runs = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const body = ghJson(`repos/${REPO}/actions/workflows/${encodeURIComponent(wf)}/runs?created=${start}..${end}&status=completed&per_page=100&page=${page}`);
    total = body.total_count;
    for (const r of body.workflow_runs || []) runs.push({ id: r.id, workflow: wf, event: r.event, conclusion: r.conclusion, headSha: r.head_sha, createdAt: r.created_at });
    if (runs.length >= total || !(body.workflow_runs || []).length) break;
  }
  if (runs.length >= total) return { runs, complete: true };
  // More runs than one query returns (*/5 crons): split the window in half, at most 3 times.
  if (depth >= 3) return { runs, complete: false };
  const mid = new Date((Date.parse(start) + Date.parse(end)) / 2).toISOString().replace(/\.\d+Z$/, 'Z');
  const a = workflowRuns(wf, start, mid, depth + 1);
  const b = workflowRuns(wf, mid, end, depth + 1);
  return { runs: [...a.runs, ...b.runs], complete: a.complete && b.complete };
}

function prodSha() {
  const r = spawnSync('node', [path.join(ROOT, 'scripts/check-prod-deploy.js'), '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout).deployedSha || null; } catch { return null; }
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function safeRun(cmd, isUsageOnlyOutput) {
  // Minimal env: no GitHub, Linear, provider or email credentials reach the child (plan review P0).
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: process.env.CI || '', NODE_ENV: 'production' };
  const [bin, ...args] = cmd.split(' ');
  const r = spawnSync(bin, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const usageOnly = isUsageOnlyOutput(out);
  return { cmd, exit: r.status, ok: r.status === 0 && !usageOnly, usageOnly, tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) };
}

function fileCard(body, auditDay, count) {
  const run = (args) => spawnSync('node', [path.join(ROOT, 'scripts/linear-brain.js'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  let open = null;
  try {
    const f = JSON.parse(run(['find', CARD_TITLE]).stdout || 'null');
    if (f && f.title === CARD_TITLE && !['completed', 'canceled'].includes(f.stateType)) open = f.identifier;
  } catch { /* none open */ }
  const r = open
    ? run(['update', open, '--comment', body])
    : run(['create', CARD_TITLE, '--dispatch', '--notes', body]);
  const id = open || ((r.stdout || '').match(/BRO-\d+/) || [])[0] || null;
  console.log(`[landed-proof] card ${open ? 'comment on' : 'created'} ${id || '(unknown id)'} for ${count} change(s) from ${auditDay} (exit ${r.status})`);
  if (r.status !== 0) console.error(String(r.stderr || '').slice(0, 500));
  return id;
}

async function main() {
  const lib = await import('./lib/landed-change-proof.mjs');
  const { loadWorkflows } = await import('./lib/live-run-stop.mjs');
  const dryRun = !!arg('dry-run');
  const auditDay = String(arg('date') || new Date().toISOString().slice(0, 10));
  const days = Number(arg('days', 3));
  const today = new Date().toISOString().slice(0, 10);
  const asOf = auditDay === today ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : `${auditDay}T09:00:00Z`;
  const windowStart = `${lib.dayMinus(auditDay, days)}T00:00:00Z`;
  const windowEnd = `${auditDay}T00:00:00Z`;

  const index = lib.workflowScriptIndex(loadWorkflows(ROOT));
  const exists = (p) => fs.existsSync(path.join(ROOT, p));
  const libIndex = lib.libWorkflowIndex(index, (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'), exists);
  let commits = readCommits(windowStart, windowEnd);
  const only = arg('sha');
  if (typeof only === 'string') { const ps = only.split(','); commits = commits.filter((c) => ps.some((p) => c.sha.startsWith(p))); }
  const posOf = positions(`${lib.dayMinus(auditDay, days + 2)}T00:00:00Z`);

  const needed = new Set();
  for (const c of commits) for (const f of c.files) for (const w of lib.classifyPath(f, { index, libIndex }).workflows) needed.add(w);
  const runs = [];
  const incomplete = new Set();
  let apiCalls = 0;
  for (const wf of needed) {
    try { apiCalls++; const r = workflowRuns(wf, windowStart, asOf); runs.push(...r.runs.filter((x) => x.createdAt < asOf)); if (!r.complete) incomplete.add(wf); }
    catch (e) { incomplete.add(wf); console.error(`[landed-proof] WARN runs for ${wf} unreadable: ${String(e.message).split('\n')[0].slice(0, 160)}`); }
  }

  const deployed = prodSha();
  const isDeployed = (sha) => {
    if (!deployed) return null;
    if (posOf.has(deployed) && posOf.has(sha)) return posOf.get(sha) <= posOf.get(deployed);
    const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, deployed], { cwd: ROOT });
    return r.status === 0 ? true : r.status === 1 ? false : null;
  };

  const rows = commits.map((c) => lib.auditCommit(c, { index, libIndex, auditDay, runs, incomplete, posOf, isDeployed }))
    .filter((r) => r.verdict !== 'exempt');

  // Safe form: run vetted read-only commands for not-run scripts (only those the safe-form gate accepts).
  const { explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');
  const ran = new Map();
  for (const r of rows.filter((x) => x.verdict === 'not_run')) {
    for (const f of r.files.filter((x) => x.verdict === 'not_run')) {
      const cmd = lib.safeRunCommand(f.file, explainUnsafeCheckCommand);
      if (!cmd) continue;
      if (dryRun || arg('no-safe-run')) { r.safeRun = { cmd, wouldRun: true }; continue; }
      if (!ran.has(cmd)) ran.set(cmd, safeRun(cmd, lib.isUsageOnlyOutput));
      r.safeRun = ran.get(cmd);
    }
  }

  const s = lib.summarize(rows);
  const byDay = {};
  for (const r of rows) (byDay[r.landedDay] ||= []).push(r);
  if (arg('json')) console.log(JSON.stringify({ auditDay, asOf, deployed, apiCalls, incomplete: [...incomplete], summary: s, rows }, null, 2));
  else {
    console.log(`[landed-proof] audit ${auditDay} (runs before ${asOf}), window ${windowStart}..${windowEnd}, prod ${deployed ? deployed.slice(0, 10) : 'UNKNOWN'}, ${needed.size} workflows queried, ${incomplete.size} incomplete`);
    for (const d of Object.keys(byDay).sort()) {
      const x = lib.summarize(byDay[d]);
      console.log(`  landed ${d}: ${x.total} code commits  verdicts ${JSON.stringify(x.verdicts)}  sources ${JSON.stringify(x.sources)}`);
    }
    console.log(`  all: ${s.total} code commits  ${JSON.stringify(s.verdicts)}`);
    console.log(`  digest: ${lib.digestLine(rows.map((r) => r), { now: new Date(`${auditDay}T12:00:00Z`) })}`);
  }

  const follow = lib.needsFollowUp(rows);
  if (arg('expect-proven')) {
    const bad = rows.filter((r) => !['proven', 'deployed', 'waiting'].includes(r.verdict));
    for (const r of bad) console.log(`  NOT PROVEN ${r.sha.slice(0, 10)} ${r.verdict} ${r.subject}`);
    process.exitCode = bad.length ? 1 : 0;
  }
  if (dryRun) { console.log(`[landed-proof] dry run: would append ${lib.newRows(readLedger(path.join(ROOT, lib.LEDGER_PATH)), rows).length} row(s), card for ${follow.length} change(s)`); return; }

  if (follow.length && process.env.LINEAR_API_KEY) {
    const id = fileCard(lib.cardBody(follow, { auditDay }), auditDay, follow.length);
    for (const r of follow) r.card = id;
  }
  const ledger = path.join(ROOT, lib.LEDGER_PATH);
  const add = lib.newRows(readLedger(ledger), rows);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  if (add.length) fs.appendFileSync(ledger, add.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[landed-proof] appended ${add.length} row(s) to ${lib.LEDGER_PATH}`);
}

// Explicit exit: an imported helper keeps a handle open and the process would otherwise never end (replay 2026-11-18).
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(`[landed-proof] FAILED: ${e && e.stack || e}`); process.exit(1); });
