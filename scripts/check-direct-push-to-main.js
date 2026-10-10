#!/usr/bin/env node
/**
 * check-direct-push-to-main.js — the detector behind
 * .github/workflows/check-direct-push-to-main.yml (BRO-3873 step 5 / BRO-3425).
 *
 * On every push to main: classify the pushed head with
 * scripts/lib/landings-ledger.js's classifyDirectPush(). A bot's own push
 * (workflow commit, CI-rebased landing, GitHub web merge) is skipped at
 * once. Anything else must have a row in data/audit/landings.jsonl — the
 * row land.yml appends AFTER the landing push, so the detector re-reads
 * origin/main's copy of the ledger every 30s for up to --wait-sec before
 * deciding. No row → routeAlert(conditionKey `direct-push:<sha>`,
 * disposition digest). Missing ledger / no sha → fail open (exit 0, no page).
 *
 *   node scripts/check-direct-push-to-main.js --sha S --actor A
 *        [--committer-name N] [--committer-email E] [--message-file F]
 *        [--changed-files-file F] [--repo-dir D] [--wait-sec 360]
 *        [--run-url U] [--compare-url U] [--kill-switch 0|1] [--no-alert] [--json]
 *
 * A push that changes no code path (scripts/lib/landings-ledger.js
 * CODE_PATH_RE — the worktree-mandatory scope) is skipped: data/memory
 * automation on the Mac pushes main directly and land.yml does not gate it.
 *
 * Exit 0 always except a usage error (2) — the workflow's notify-failure is
 * for the job breaking, not for the verdict; the verdict travels by digest.
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { LANDINGS_REL, parseLandings, classifyDirectPush, buildDirectPushAlert } = require('./lib/landings-ledger.js');

const USAGE = `check-direct-push-to-main.js — was this main sha landed through land.yml?

Usage:
  node scripts/check-direct-push-to-main.js --sha S --actor A [--committer-name N] [--committer-email E]
       [--message-file F] [--repo-dir D] [--wait-sec 360] [--run-url U] [--compare-url U]
       [--kill-switch 0|1] [--no-alert] [--json]

Prints one line: DIRECT-PUSH: <verdict> <sha> (<reason>). Exit 0 (fail-open), 2 on usage.`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) { a[t.slice(2, eq)] = t.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { a[t.slice(2)] = next; i++; }
    else a[t.slice(2)] = true;
  }
  return a;
}

// origin/main's CURRENT ledger, not the checkout's: the row for this very
// push is committed by land.yml after the push event fires.
function fetchOriginLandings(repoDir) {
  try {
    execFileSync('git', ['fetch', '--depth=1', '-q', 'origin', 'main'], { cwd: repoDir, stdio: 'ignore', timeout: 90_000 });
  } catch {
    return null;
  }
  try {
    const text = execFileSync('git', ['show', `FETCH_HEAD:${LANDINGS_REL}`], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    return { available: true, rows: parseLandings(text) };
  } catch {
    return { available: false, rows: [] };
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main(argv = process.argv.slice(2), { fetchLandings = fetchOriginLandings, route = null, now = Date.now, wait = sleep } = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const args = parseArgs(argv);
  if (!args.sha || args.sha === true) { console.error(USAGE); return 2; }
  const repoDir = args['repo-dir'] && args['repo-dir'] !== true ? String(args['repo-dir']) : process.cwd();
  const waitSec = Number(args['wait-sec'] === undefined ? 360 : args['wait-sec']);
  const killSwitch = String(args['kill-switch'] || '') === '1';
  let message = '';
  if (args['message-file'] && args['message-file'] !== true) {
    try { message = fs.readFileSync(String(args['message-file']), 'utf8'); } catch { message = ''; }
  }
  // --changed-files-file: one path per line (the compare API's files[]);
  // absent or empty → unknown, judged as code (never a reason to skip).
  let changedFiles = null;
  if (args['changed-files-file'] && args['changed-files-file'] !== true) {
    try {
      const list = fs.readFileSync(String(args['changed-files-file']), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
      changedFiles = list.length ? list : null;
    } catch { changedFiles = null; }
  }
  const base = {
    sha: String(args.sha),
    actor: args.actor && args.actor !== true ? String(args.actor) : '',
    committerName: args['committer-name'] && args['committer-name'] !== true ? String(args['committer-name']) : '',
    committerEmail: args['committer-email'] && args['committer-email'] !== true ? String(args['committer-email']) : '',
    killSwitch,
    changedFiles,
  };

  // Cheap verdicts first (bot / kill switch / no sha) — no fetch at all.
  let verdict = classifyDirectPush({ ...base, landings: [], landingsAvailable: true });
  if (verdict.verdict === 'direct') {
    const deadline = now() + Math.max(0, waitSec) * 1000;
    for (;;) {
      const led = fetchLandings(repoDir);
      if (led === null) { verdict = { verdict: 'unknown', reason: 'fetch-failed' }; break; }
      verdict = classifyDirectPush({ ...base, landings: led.rows, landingsAvailable: led.available });
      if (verdict.verdict !== 'direct' || now() >= deadline) break;
      await wait(30_000);
    }
  }

  const line = `DIRECT-PUSH: ${verdict.verdict} ${base.sha} (${verdict.reason})`;
  if (args.json) console.log(JSON.stringify({ ...verdict, sha: base.sha }));
  else console.log(line);

  if (verdict.verdict === 'direct' && !args['no-alert']) {
    const routeAlert = route || require('./lib/owner-alert-router.js').routeAlert;
    const alert = buildDirectPushAlert({
      ...base,
      message,
      runUrl: args['run-url'] && args['run-url'] !== true ? String(args['run-url']) : '',
      compareUrl: args['compare-url'] && args['compare-url'] !== true ? String(args['compare-url']) : '',
    });
    const res = await routeAlert(alert);
    console.log(`direct-push alert: ${res && res.action ? res.action : 'routed'} ${alert.conditionKey}`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    // Fail open: a broken detector must never page or redden main.
    console.error(`check-direct-push-to-main: ${err.message}`);
    process.exit(0);
  });
}

module.exports = { main, parseArgs, fetchOriginLandings, USAGE };
