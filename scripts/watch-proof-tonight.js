#!/usr/bin/env node
/**
 * Opening-night live status board.
 *
 * Refreshes every 30 sec with:
 *   - Pipeline state (stage-latency events for in-flight reviews)
 *   - Drift detector (last cron run + current drift-state.json)
 *   - Exclusions log (silent drops in the last hour)
 *   - Review counts: local / reviews.json / live
 *   - Workflow runs: opening-night-poller, gather-reviews, rebuild, score, deploy, broadcast
 *
 * Usage:
 *   node scripts/watch-proof-tonight.js --show=proof-2026
 *   node scripts/watch-proof-tonight.js                    # auto-detects opening-window shows
 *   node scripts/watch-proof-tonight.js --once             # single snapshot, no refresh loop
 *   node scripts/watch-proof-tonight.js --interval=60      # custom refresh seconds
 *
 * Read-only: never modifies data. Safe to run alongside active opening night.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const SHOW_ID = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;
const ONCE = args.includes('--once');
const INTERVAL_SEC = parseInt((args.find(a => a.startsWith('--interval=')) || '').replace('--interval=', ''), 10) || 30;

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const STAGE_LATENCY_FILE = path.join(DATA_DIR, 'audit', 'stage-latency.jsonl');
const DRIFT_STATE_FILE = path.join(DATA_DIR, 'audit', 'drift-state.json');
const EXCLUSIONS_GLOB = path.join(DATA_DIR, 'audit');
const REMEDIATION_LOG = path.join(DATA_DIR, 'audit', 'remediation-log.jsonl');

const CRITICAL_WORKFLOWS = [
  'opening-night-orchestrator.yml',
  'opening-night-poller.yml',
  'opening-night-broadcast.yml',
  'gather-reviews.yml',
  'collect-review-texts.yml',
  'rebuild-reviews.yml',
  'llm-ensemble-score.yml',
  'vercel-deploy.yml',
  'check-opening-night-drift.yml',
  'opening-night-checklist.yml',
];

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return raw.shows || raw;
}

function loadReviewsDoc() {
  try {
    const raw = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    const arr = raw.reviews || raw;
    const byShow = {};
    for (const r of arr) {
      const id = r.showId || r.show;
      if (!id) continue;
      (byShow[id] = byShow[id] || []).push(r);
    }
    return byShow;
  } catch { return {}; }
}

function getTargetShowIds() {
  if (SHOW_ID) return [SHOW_ID];
  const shows = loadShows();
  const now = Date.now();
  const WIN = 3 * 86400000;
  return shows
    .filter(s => {
      if (!s.openingDate) return false;
      const d = new Date(s.openingDate).getTime();
      return Math.abs(d - now) <= WIN;
    })
    .map(s => s.id);
}

function countLocalFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return { total: 0, stubs: 0, withText: 0, withScore: 0 };
  let total = 0, stubs = 0, withText = 0, withScore = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    total++;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d.contentTier === 'stub' || (!d.fullText && !d.aggregatorStars)) stubs++;
      if (d.fullText && d.fullText.trim().length > 100) withText++;
      if (d.llmScore || d.assignedScore != null) withScore++;
    } catch {}
  }
  return { total, stubs, withText, withScore };
}

async function fetchLiveRc(showId) {
  try {
    const r = await fetch(`https://broadwayscorecard.com/data/shows/${showId}.json`, { headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) return { rc: null, err: `HTTP ${r.status}` };
    const j = await r.json();
    return { rc: j.rc ?? null, cs: j.cs ?? null };
  } catch (e) { return { rc: null, err: e.message }; }
}

function readStageLatency(showId, sinceMs) {
  if (!fs.existsSync(STAGE_LATENCY_FILE)) return [];
  const lines = fs.readFileSync(STAGE_LATENCY_FILE, 'utf8').split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.showId !== showId) continue;
      const t = Date.parse(e.at || e.ts);
      if (isFinite(t) && t >= sinceMs) events.push(e);
    } catch {}
  }
  return events;
}

function readRecentExclusions(showId, sinceMs) {
  try {
    const files = fs.readdirSync(EXCLUSIONS_GLOB).filter(f => f.startsWith('exclusions-') && f.endsWith('.jsonl'));
    files.sort().reverse();
    const events = [];
    for (const f of files.slice(0, 2)) {
      const lines = fs.readFileSync(path.join(EXCLUSIONS_GLOB, f), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.showId !== showId) continue;
          const t = Date.parse(e.at || e.ts);
          if (isFinite(t) && t >= sinceMs) events.push(e);
        } catch {}
      }
    }
    return events;
  } catch { return []; }
}

function readDriftState() {
  try { return JSON.parse(fs.readFileSync(DRIFT_STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function readRemediationLog(showId, sinceMs) {
  if (!fs.existsSync(REMEDIATION_LOG)) return [];
  const lines = fs.readFileSync(REMEDIATION_LOG, 'utf8').split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.showId !== showId) continue;
      const t = Date.parse(e.at);
      if (isFinite(t) && t >= sinceMs) events.push(e);
    } catch {}
  }
  return events;
}

function ghRunState(workflow) {
  try {
    const out = execSync(`gh run list --workflow=${workflow} --limit=1 --json status,conclusion,createdAt --jq '.[0]'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch { return null; }
}

async function render() {
  const now = Date.now();
  const HOUR_AGO = now - 3600000;
  console.clear();
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(`  OPENING NIGHT WATCH  |  ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC  |  refresh: ${ONCE ? 'once' : INTERVAL_SEC + 's'}`);
  console.log('════════════════════════════════════════════════════════════════════');

  // ─── Per-show state
  const reviewsDoc = loadReviewsDoc();
  const showIds = getTargetShowIds();
  if (showIds.length === 0) {
    console.log('\nNo shows in openingDate ±3d.');
  }
  for (const id of showIds) {
    const local = countLocalFiles(id);
    const aggregate = (reviewsDoc[id] || []).length;
    const live = await fetchLiveRc(id);
    const stages = readStageLatency(id, HOUR_AGO);
    const exclusions = readRecentExclusions(id, HOUR_AGO);
    const drift = readDriftState()[id];
    const remediation = readRemediationLog(id, HOUR_AGO);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━ ${id} ━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  📂 Local files: ${local.total} total | ${local.stubs} stubs | ${local.withText} with text | ${local.withScore} scored`);
    console.log(`  📊 reviews.json: ${aggregate}`);
    console.log(`  🌐 Live: ${live.rc ?? '?'} (score ${live.cs ?? '-'}${live.err ? ' | err:' + live.err : ''})`);
    if (drift) {
      const age = Math.round((now - new Date(drift.lastAlertTs || drift.firstSeen || 0).getTime()) / 60000);
      console.log(`  🎯 Drift: fingerprint ${drift.fingerprint || '(none)'} | seen ${age}min ago`);
    }
    if (stages.length > 0) {
      const byStage = {};
      for (const s of stages) byStage[s.stage] = (byStage[s.stage] || 0) + 1;
      console.log(`  ⏱  Pipeline stages (last 1h): ${Object.entries(byStage).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    if (remediation.length > 0) {
      const byAction = {};
      for (const r of remediation) byAction[r.action] = (byAction[r.action] || 0) + 1;
      console.log(`  🔧 Remediation (last 1h): ${Object.entries(byAction).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    if (exclusions.length > 0) {
      const byReason = {};
      for (const e of exclusions) byReason[e.reason || 'unknown'] = (byReason[e.reason || 'unknown'] || 0) + 1;
      const top = Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`  🚫 Exclusions (last 1h): ${top.map(([r, n]) => `${r}=${n}`).join(' ')}${exclusions.length > top.reduce((s, [, n]) => s + n, 0) ? ' …' : ''}`);
    }
  }

  // ─── Workflow runs
  console.log('\n━━━━━━━━━━━━━━━━━━━━━ Workflows ━━━━━━━━━━━━━━━━━━━━━');
  for (const wf of CRITICAL_WORKFLOWS) {
    const r = ghRunState(wf);
    if (!r) { console.log(`  ${wf.padEnd(38)} (no runs)`); continue; }
    const status = r.conclusion || r.status || '?';
    const emoji = status === 'success' ? '✅' : status === 'failure' ? '❌' : status === 'cancelled' ? '⚠️' : status === 'in_progress' ? '🔄' : '•';
    const age = Math.round((now - new Date(r.createdAt).getTime()) / 60000);
    console.log(`  ${emoji}  ${wf.padEnd(38)} ${status.padEnd(14)} (${age}min ago)`);
  }
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log(`  Press Ctrl-C to stop  |  Tail commands:`);
  showIds.forEach(id => console.log(`    grep '"showId":"${id}"' data/audit/exclusions-*.jsonl | jq -r '.reason' | sort | uniq -c | sort -rn`));
}

async function main() {
  await render();
  if (ONCE) return;
  setInterval(() => render().catch(e => console.error('render error:', e.message)), INTERVAL_SEC * 1000);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
