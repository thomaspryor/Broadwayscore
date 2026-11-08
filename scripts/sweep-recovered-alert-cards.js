#!/usr/bin/env node
/**
 * sweep-recovered-alert-cards.js — board closer (BRO-7135). Rules and why:
 * scripts/lib/board-closer.js.
 *
 *   node scripts/sweep-recovered-alert-cards.js --dry-run         report only (default)
 *   node scripts/sweep-recovered-alert-cards.js --apply           close recovered alert cards (max 25 per run)
 *   node scripts/sweep-recovered-alert-cards.js --landed          also list/close cards whose land/<name> branch is live
 *   node scripts/sweep-recovered-alert-cards.js --landed --apply  landed closer writes too
 *
 * The landed closer is dry-run unless --landed --apply are BOTH given, so the
 * daily workflow (--apply) only closes recovered alert cards at first.
 * Closes through linear-brain.js, so the Done gate re-runs. Exit 0 on success
 * (including nothing to do), 3 when Linear could not be read.
 */

'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const bc = require('./lib/board-closer.js');

const REPO = path.join(__dirname, '..');
const MAX_PER_RUN = 25;
const USAGE = 'Usage: node scripts/sweep-recovered-alert-cards.js [--dry-run] [--apply] [--landed]';

const noisy = async (fn) => {
  // check-health-row-absent logs its verdict; keep the sweep output to one line per card.
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

async function healthRowExit(row) {
  const { main } = require('./check-health-row-absent.js');
  const { rowAbsentCheckCmd } = require('./lib/health-row-check-cmd.js');
  const token = rowAbsentCheckCmd(row).split(' ').pop();
  return noisy(() => main(['node', 'check-health-row-absent.js', '--row-b64', token]));
}

function prodExit(sha) {
  const r = spawnSync('node', [path.join(__dirname, 'check-prod-deploy.js'), sha], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  return r.status === null ? 2 : r.status;
}

function readLandings() {
  const { parseLandings, LANDINGS_REL } = require('./lib/landings-ledger.js');
  const text = execFileSync('git', ['show', `origin/main:${LANDINGS_REL}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
  return parseLandings(text);
}

function close(identifier, comment) {
  const r = spawnSync('node', [path.join(__dirname, 'linear-brain.js'), 'update', identifier, '--state', 'Done', '--comment', comment],
    { cwd: REPO, encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) console.error(`close failed for ${identifier}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return r.status === 0;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  const landed = argv.includes('--landed');
  const linear = deps.linear || require('./lib/linear-client.js');
  const checkRow = deps.healthRowExit || healthRowExit;
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  let closed = 0;

  let open;
  try { open = await linear.listOpenIssuesWithDescriptions(); } catch (err) {
    console.error(`[sweep-recovered-alert-cards] could not list open issues: ${err.message}`);
    return 3;
  }

  const candidates = [];
  for (const issue of open) {
    const c = bc.classifyAlertCard(issue);
    if (c.kind === 'not-alert' || c.kind === 'terminal') continue;
    if (c.kind !== 'candidate') { bump(c.kind); continue; }
    candidates.push({ issue, ...c });
  }
  // One health-row check per distinct row, however many cards name it.
  const exitByRow = new Map();
  for (const c of candidates) {
    if (!exitByRow.has(c.row)) exitByRow.set(c.row, await checkRow(c.row));
    const d = bc.decideRecovered(exitByRow.get(c.row));
    if (d.action !== 'close') { bump(d.reason); continue; }
    if (!apply) { console.log(`would close ${c.issue.identifier} (${c.row})`); bump('recovered'); continue; }
    if (closed >= MAX_PER_RUN) { bump('over-run-cap'); continue; }
    if (close(c.issue.identifier, bc.recoveredComment(c.row))) { closed++; console.log(`closed ${c.issue.identifier} (${c.row})`); bump('closed'); }
    else bump('close-failed');
  }

  if (landed) {
    let rows;
    try { rows = (deps.readLandings || readLandings)(); } catch (err) {
      console.error(`[sweep-recovered-alert-cards] could not read landings ledger: ${err.message.split('\n')[0]}`);
      rows = null;
    }
    const started = open.filter((i) => i.state && (i.state.type === 'started' || i.state.type === 'unstarted'));
    const comments = rows ? await linear.listIssueComments(started.map((i) => i.identifier), undefined, { maxPerIssue: 5 }) : new Map();
    for (const issue of started) {
      const branch = bc.landBranchFromComments(comments.get(issue.identifier));
      if (!branch) continue;
      const landing = bc.landingForBranch(rows, branch);
      const liveExit = landing ? (deps.prodExit || prodExit)(landing.sha) : null;
      const d = bc.decideLanded(issue, { branch, landing, liveExit });
      if (d.action !== 'close') { bump(`landed:${d.reason}`); continue; }
      if (!apply) { console.log(`would close ${issue.identifier} (${branch} live at ${d.sha.slice(0, 10)})`); bump('landed:eligible'); continue; }
      if (closed >= MAX_PER_RUN) { bump('over-run-cap'); continue; }
      if (close(issue.identifier, bc.landedComment(branch, d.sha))) { closed++; console.log(`closed ${issue.identifier} (${branch})`); bump('landed:closed'); }
      else bump('close-failed');
    }
  }

  console.log(`[sweep-recovered-alert-cards] open ${open.length}; alert candidates ${candidates.length}; ${apply ? 'APPLY' : 'dry-run'}; ${JSON.stringify(counts)}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[sweep-recovered-alert-cards] ${err.stack || err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { main };
