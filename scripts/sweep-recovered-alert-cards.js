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
 * A recovered alert needs the alert ledger to say resolved AND the health row
 * absent (row absence alone is not recovery). Kill switch: BOARD_CLOSER_KILL_SWITCH=1.
 * Closes through linear-brain.js, so the Done gate re-runs. Exit 0 on success
 * (including nothing to do), 3 when Linear could not be read.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const bc = require('./lib/board-closer.js');

const fs = require('fs');
const REPO = path.join(__dirname, '..');
const MAX_PER_RUN = 25;
const LEDGER = path.join(REPO, 'data/audit/alert-ledger.json');
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
  // Local checkout file, like close-stuck-verified-cards (no depth-1 origin/main staleness).
  const r = require('./lib/landings-ledger.js').readLandings(REPO);
  if (!r.available) throw new Error('data/audit/landings.jsonl not found');
  return r.rows;
}

const CHILD_ENV = { ...process.env }; // snapshot before releaseTracker sets ALERT_LEDGER_PATH

function close(identifier, comment) {
  const r = spawnSync('node', [path.join(__dirname, 'linear-brain.js'), 'update', identifier, '--state', 'Done', '--comment', comment],
    { cwd: REPO, encoding: 'utf8', timeout: 180000, env: CHILD_ENV });
  if (r.status !== 0) console.error(`close failed for ${identifier}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return r.status === 0;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  if (process.env.BOARD_CLOSER_KILL_SWITCH === '1') { console.log('[sweep-recovered-alert-cards] kill switch set, nothing to do'); return 0; }
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  const landed = argv.includes('--landed');
  const linear = deps.linear || require('./lib/linear-client.js');
  const checkRow = deps.healthRowExit || healthRowExit;
  const counts = {};
  let ledger;
  try { ledger = deps.ledger || JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (err) {
    console.error(`[sweep-recovered-alert-cards] could not read alert ledger: ${err.message}`);
    return 3;
  }
  const releaseTracker = deps.releaseTracker || ((key, id) => {
    if (!process.env.ALERT_LEDGER_PATH) process.env.ALERT_LEDGER_PATH = LEDGER;
    return require('./lib/owner-alert-router').releaseSweptTracker(key, id);
  });
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  let closed = 0;
  let attempts = 0;

  let open;
  try { open = await linear.listOpenIssuesWithDescriptions(); } catch (err) {
    console.error(`[sweep-recovered-alert-cards] could not list open issues: ${err.message}`);
    return 3;
  }

  const candidates = [];
  for (const issue of open) {
    const c = bc.classifyAlertCard(issue, ledger);
    if (c.kind === 'not-alert' || c.kind === 'terminal') continue;
    if (c.kind !== 'candidate') { bump(c.kind); continue; }
    candidates.push({ issue, ...c });
  }
  // One health-row check per distinct row, however many cards name it.
  const exitByRow = new Map();
  for (const c of candidates) {
    const lg = bc.ledgerSaysRecovered(ledger, c.issue.identifier, c.conditionKey);
    if (!lg.ok) { bump(lg.reason); continue; }
    if (!exitByRow.has(c.row)) exitByRow.set(c.row, await checkRow(c.row));
    const d = bc.decideRecovered(exitByRow.get(c.row));
    if (d.action !== 'close') { bump(d.reason); continue; }
    if (!apply) { console.log(`would close ${c.issue.identifier} (${c.row})`); bump('recovered'); continue; }
    if (attempts >= MAX_PER_RUN) { bump('over-run-cap'); continue; }
    attempts++;
    if ((deps.close || close)(c.issue.identifier, bc.recoveredComment(c.row))) {
      closed++; bump('closed');
      const released = releaseTracker(c.conditionKey, c.issue.identifier);
      console.log(`closed ${c.issue.identifier} (${c.row})${released ? ' — tracker released' : ''}`);
    }
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
      const newest = (comments.get(issue.identifier) || [])[0];
      const landing = bc.landingForBranch(rows, branch, Date.parse(newest && newest.createdAt) - bc.LANDING_SLACK_MS);
      const liveExit = landing ? (deps.prodExit || prodExit)(landing.sha) : null;
      const d = bc.decideLanded(issue, { branch, landing, liveExit });
      if (d.action !== 'close') { bump(`landed:${d.reason}`); continue; }
      if (!apply) { console.log(`would close ${issue.identifier} (${branch} live at ${d.sha.slice(0, 10)})`); bump('landed:eligible'); continue; }
      if (attempts >= MAX_PER_RUN) { bump('over-run-cap'); continue; }
    attempts++;
      if ((deps.close || close)(issue.identifier, bc.landedComment(branch, d.sha))) { closed++; console.log(`closed ${issue.identifier} (${branch})`); bump('landed:closed'); }
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
