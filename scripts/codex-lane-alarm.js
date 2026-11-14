#!/usr/bin/env node
'use strict';
// BRO-6134 stage 1: hourly outside-signal health alarm for the Codex lanes.
// Reads git landings, the runner's BRO-4745 summaries and stand-down notes, the codex-runner.yml run
// list and the stored login's public stamps on BRO-4799 (never the encrypted login), runs the
// pure scripts/lib/codex-lane-health.js, and (with --alert) files ONE Linear card per lane:class
// confirmed on two consecutive hourly evaluations. Shadow by default: without --alert it only
// reports. An unreadable source is "health unknown", never a breach.
//
//   node scripts/codex-lane-alarm.js [--alert] [--strict [--unknown-ok]] [--out=FILE] [--dump-sources=DIR]
// Exit: 0 ran (cards, if any, filed) | 1 --strict and a confirmed breach | 2 no source readable
//       | 3 --alert and a card has no tracker.
if (require.main === module && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  console.log('Usage: node scripts/codex-lane-alarm.js [--alert] [--strict [--unknown-ok]] [--out=FILE] [--dump-sources=DIR]\nHourly Codex lane health from outside signals (BRO-6134). Shadow unless --alert.');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LANDED_LOG_FORMAT, parseAuthMeta } = require('./lib/codex-runner.js');
const { codexLandedEvents, confirmedBreaches, FLOORS } = require('./lib/codex-lane-health.js');

const RUNNER_ISSUE = 'BRO-4745';
const KEY_PREFIX = 'codex-lane:';
const VERIFY = 'VERIFY: node --test tests/live/codex-lane-alarm-clean.test.mjs';
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const flag = (n) => process.argv.includes(`--${n}`);

function readLanded() {
  try {
    // A shallow checkout sees one commit, which would read as "nothing landed" on every run.
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') return null;
    return execFileSync('git', ['log', 'origin/main', '--since=4 days ago', `--format=%ct000%x09${LANDED_LOG_FORMAT}`],
      { encoding: 'utf8', maxBuffer: 32 << 20 });
  } catch { return null; }
}

async function readSummaries(days = 4) {
  try {
    const { graphql } = require('./lib/linear-client.js');
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const out = [];
    let after = null;
    for (;;) {
      const d = await graphql(`query($since: DateTimeOrDuration!, $after: String) { issues(filter:{team:{key:{eq:"BRO"}},number:{eq:${Number(RUNNER_ISSUE.split('-')[1])}}}) { nodes { comments(first:100, after:$after, filter:{createdAt:{gt:$since}}) { nodes { createdAt body } pageInfo { hasNextPage endCursor } } } } }`, { since, after });
      const c = d.issues.nodes[0].comments;
      out.push(...c.nodes);
      if (!c.pageInfo.hasNextPage) break;
      after = c.pageInfo.endCursor;
    }
    // A runner that posts every ~2h leaves dozens in 4 days; none means the read is wrong, not the lane.
    return out.length ? out : null;
  } catch { return null; }
}

// The stored login's public stamps only (last_refresh, saved, access_expires); the encrypted blob is never kept.
async function readLogin() {
  try {
    const { graphql } = require('./lib/linear-client.js');
    const d = await graphql('query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }', { id: process.env.CODEX_AUTH_STORE_ISSUE || 'BRO-4799' });
    for (const c of (d.issue && d.issue.comments.nodes) || []) {
      const meta = parseAuthMeta(c.body);
      if (meta) return meta;
    }
    return null;
  } catch { return null; }
}

function readRuns() {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
    const out = execFileSync('gh', ['api', `repos/${repo}/actions/workflows/codex-runner.yml/runs?per_page=30`], { encoding: 'utf8', maxBuffer: 16 << 20 });
    return JSON.parse(out).workflow_runs || [];
  } catch { return null; }
}

const toGhRuns = (runs) => (runs === null ? null : runs.map((r) => {
  const startMs = Date.parse(r.run_started_at || r.created_at);
  return { startMs, endMs: r.status === 'completed' ? Date.parse(r.updated_at) : null, durationMin: r.status === 'completed' ? (Date.parse(r.updated_at) - startMs) / 60000 : null, conclusion: r.status === 'completed' ? r.conclusion : null };
}));

async function main() {
  const landedRaw = readLanded();
  const summaries = await readSummaries();
  const runsRaw = readRuns();
  const login = await readLogin();
  const dump = arg('dump-sources');
  if (dump) {
    fs.mkdirSync(dump, { recursive: true });
    if (landedRaw !== null) fs.writeFileSync(path.join(dump, 'landed.log'), landedRaw);
    if (summaries !== null) fs.writeFileSync(path.join(dump, 'c4745.json'), JSON.stringify(summaries));
    if (runsRaw !== null) fs.writeFileSync(path.join(dump, 'runs.json'), JSON.stringify(runsRaw));
    if (login !== null) fs.writeFileSync(path.join(dump, 'login.json'), JSON.stringify(login));
  }
  const inputs = {
    nowMs: Date.now(),
    landed: landedRaw === null ? null : codexLandedEvents(landedRaw),
    summaries,
    ghRuns: toGhRuns(runsRaw),
    lockAgeH: null, // read from the newest cloud lock-held stand-down note (codex-lane-health.js)
    login,
  };
  if (inputs.landed === null && summaries === null && inputs.ghRuns === null) {
    console.error('codex-lane-alarm: no source readable (git, Linear, GitHub runs)');
    return 2;
  }
  const { now, prev, confirmed } = confirmedBreaches(inputs);
  const lines = [`Codex lane health: ${now.status}${confirmed.length ? ` (${confirmed.length} confirmed)` : ''}`];
  for (const b of now.breaches) lines.push(`- ${b.lane}:${b.cls} ${confirmed.includes(b) ? '[confirmed]' : '[first hour]'} ${b.why}`);
  if (now.unknown.length) lines.push(`- health unknown (source unreadable): ${now.unknown.join(', ')}`);
  lines.push(`facts: ${JSON.stringify(now.facts)}  floors: ${JSON.stringify(FLOORS)}`);
  console.log(lines.join('\n'));
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ at: new Date().toISOString(), status: now.status, confirmed, breaches: now.breaches, unknown: now.unknown, facts: now.facts }, null, 2) + '\n');

  let dispatchFailed = false;
  if (flag('alert')) {
    const { routeAlert, resolveCondition, loadLedger } = require('./lib/owner-alert-router');
    // Resolve only after two clean evaluations in a row (a condition hovering at a floor must not close a card mid-fix).
    const live = new Set([...now.breaches, ...prev.flatMap((p) => p.breaches)].map((b) => `${KEY_PREFIX}${b.lane}:${b.cls}`));
    const ledger = loadLedger();
    for (const [key, c] of Object.entries((ledger && ledger.conditions) || {})) {
      // Only close a card when the source that raised it was readable and clean; unknown never resolves.
      if (key.startsWith(KEY_PREFIX) && c.status === 'open' && !live.has(key) && now.unknown.length === 0) resolveCondition(key, { reason: 'codex-lane-alarm: healthy again' });
    }
    const runId = process.env.GITHUB_RUN_ID;
    const dispatchAtFiling = runId ? { runId, runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : null } : undefined;
    for (const b of confirmed) {
      const key = `${KEY_PREFIX}${b.lane}:${b.cls}`;
      try {
        const r = await routeAlert({
          conditionKey: key,
          title: `Codex ${b.lane} lane is not working (${b.cls}): ${b.why.slice(0, 80)}`,
          description: `Seen on two hourly checks in a row from outside signals (git landings, the BRO-4745 summaries, codex-runner.yml runs). ${b.why}.\n\nTechnical: scripts/lib/codex-lane-health.js via scripts/codex-lane-alarm.js (BRO-6134), .github/workflows/codex-lane-health.yml. Read the newest "## Codex runner" comments on BRO-4745 and the codex-runner.yml run log, fix the cause, then confirm with the VERIFY line.`,
          hint: 'Find why the lane stopped (lock, disk, usage limit, Done gate, quiet exit 0) and fix the cause, not the symptom. Do not loosen FLOORS in scripts/lib/codex-lane-health.js to silence this.',
          severity: 'error', disposition: 'auto', cardAction: 'Fix', dispatchAtFiling,
          verify: { line: VERIFY, note: 'passes only when no lane:class is confirmed breached on two consecutive hourly checks' },
        });
        console.log(`   [alert] ${key} -> ${r.action}${r.linearIdentifier ? ` (${r.linearIdentifier})` : ''}`);
        if (r.dispatchOk === false || ((r.action === 'auto' || r.action === 'silent') && !r.linearIdentifier)) dispatchFailed = true;
      } catch (e) { dispatchFailed = true; console.error(`[alert] routeAlert threw for ${key}: ${e.message}`); }
    }
  }
  if (dispatchFailed) return 3;
  return flag('strict') && (confirmed.length || (now.unknown.length && !flag('unknown-ok'))) ? 1 : 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(2); });
module.exports = { toGhRuns, readSummaries };
