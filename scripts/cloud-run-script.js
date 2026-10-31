#!/usr/bin/env node
'use strict';

/**
 * cloud-run-script.js — run a committed repo script with the production API keys,
 * from a cloud session that does not hold them (BRO-5008).
 *
 * The Mac runs `node scripts/x.js` with its local .env. Cloud sessions (iPhone,
 * iPad, claude.ai/code) have no .env and cannot read GitHub secrets, so before
 * this every "needs PostHog / GA4 / Vercel / scraper keys" question ended in an
 * email asking the owner to run it at the Mac. This dispatches run-script.yml,
 * which runs the script on main inside Actions with the read/analysis keys, waits
 * for it, and prints the script's output here as if it ran locally.
 *
 * Usage:
 *   node scripts/cloud-run-script.js [--review-texts] [--review-texts-depth=N] [--timeout=MIN] [--queue-wait=MIN] <scripts/x.js> [args...]
 *
 * Exit code: the script's own exit code; 3 when the run could not be started or
 * read (dispatch refused, run never appeared, timeout).
 *
 * The repo is public, so the output travels encrypted to a key pair made for
 * this one run (scripts/lib/sealed-output.js); only this process can read it.
 *
 * The script path and arguments are NOT encrypted: they show in the public run.
 * Never pass reader emails, review text or other private data as arguments.
 *
 * Limits: runs the script as it is on origin/main (land first), never pushes, and
 * discards any files it writes. No RESEND key (email goes through its dedicated
 * workflows, CLAUDE.md §17) and no outlet logins.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateKeyPair, open } = require('./lib/sealed-output');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO = process.env.RUN_SCRIPT_REPO || 'thomaspryor/Broadwayscore';
const WORKFLOW = 'run-script.yml';
const BEGIN = '=== RUN-SCRIPT OUTPUT BEGIN ===';
const END = '=== RUN-SCRIPT OUTPUT END ===';
const EXIT_RE = /=== RUN-SCRIPT EXIT (\d+) ===/;
// Same rule the workflow enforces; checked here too so a typo fails in a second
// instead of after a dispatch round trip.
const SCRIPT_RE = /^scripts\/[A-Za-z0-9._/-]+\.(?:js|mjs|cjs|ts)$/;

function validateScriptPath(p) {
  if (!SCRIPT_RE.test(p) || p.split('/').includes('..')) {
    return `script must be a path under scripts/ ending in .js/.mjs/.cjs/.ts, got "${p}"`;
  }
  return null;
}

function parseArgs(argv) {
  const opts = { reviewTexts: false, reviewTextsDepth: 1, timeoutMin: 30, queueWaitMin: 240, script: null, args: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--review-texts') opts.reviewTexts = true;
    // History audits (BRO-5373): N commits of review-texts, 0 = full. The run
    // drops the clone's credentials, so a script cannot fetch more itself.
    else if (a.startsWith('--review-texts-depth=')) { opts.reviewTexts = true; opts.reviewTextsDepth = Number(a.slice(21)); }
    else if (a.startsWith('--timeout=')) opts.timeoutMin = Number(a.slice(10));
    else if (a.startsWith('--queue-wait=')) opts.queueWaitMin = Number(a.slice(13));
    else break;
  }
  opts.script = argv[i] || null;
  opts.args = argv.slice(i + 1);
  return opts;
}

// Job logs prefix every line with an ISO timestamp and a space.
function stripTimestamp(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '');
}

/**
 * When to stop polling. Queue time does not count against --timeout: a run that sat
 * queued for an hour behind a busy Actions pool used to hit the deadline while its
 * script was still working, and the sealed output was lost with this process's key
 * (BRO-6485). The queue gets its own --queue-wait limit; the script limit starts
 * when the run is first seen in progress. A run given up on is not cancelled: it
 * still runs, but its output can no longer be read.
 */
function pollDeadline({ dispatchedAt, startedAt, timeoutMin, queueWaitMin }) {
  if (startedAt == null) return dispatchedAt + queueWaitMin * 60 * 1000;
  // 25 = run-script.yml's job timeout-minutes (80) minus the 55-min script cap.
  return startedAt + (timeoutMin + 25) * 60 * 1000;
}

function extractOutput(logText) {
  const lines = logText.split(/\r?\n/).map(stripTimestamp);
  const b = lines.indexOf(BEGIN);
  const e = lines.indexOf(END, b + 1);
  const exitLine = lines.find((l) => EXIT_RE.test(l));
  return {
    found: b !== -1,
    output: b === -1 ? '' : lines.slice(b + 1, e === -1 ? undefined : e).join('\n'),
    exitCode: exitLine ? Number(exitLine.match(EXIT_RE)[1]) : null,
  };
}

function gh(args, { input } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function ghJson(apiPath) {
  return JSON.parse(gh(['api', apiPath]));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findRun(requestId, deadline) {
  while (Date.now() < deadline) {
    const data = ghJson(`repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
    const run = (data.workflow_runs || []).find((r) => (r.name || '').includes(requestId) || (r.display_title || '').includes(requestId));
    if (run) return run;
    sleep(5000);
  }
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.script || hasHelpFlag([opts.script])) {
    console.error('Usage: node scripts/cloud-run-script.js [--review-texts] [--review-texts-depth=N] [--timeout=MIN] [--queue-wait=MIN] <scripts/x.js> [args...]');
    return opts.script ? 0 : 2;
  }
  const bad = validateScriptPath(opts.script);
  if (bad) { console.error(bad); return 2; }
  if (!Number.isInteger(opts.reviewTextsDepth) || opts.reviewTextsDepth < 0 || opts.reviewTextsDepth > 100000) {
    console.error('--review-texts-depth must be a whole number from 0 (full history) to 100000');
    return 2;
  }
  if (!Number.isInteger(opts.timeoutMin) || opts.timeoutMin < 1 || opts.timeoutMin > 55) {
    console.error('--timeout must be a whole number of minutes from 1 to 55');
    return 2;
  }
  if (!Number.isInteger(opts.queueWaitMin) || opts.queueWaitMin < 1 || opts.queueWaitMin > 600) {
    console.error('--queue-wait must be a whole number of minutes from 1 to 600');
    return 2;
  }
  if (!fs.existsSync(path.join(__dirname, '..', opts.script))) {
    console.error(`warning: ${opts.script} is not in this checkout; the run uses origin/main.`);
  }

  const requestId = crypto.randomBytes(6).toString('hex');
  const dispatchedAt = Date.now();
  const { publicKey, privateKey } = generateKeyPair();
  try {
    gh(['workflow', 'run', WORKFLOW, '--repo', REPO, '--ref', 'main',
      '-f', `script=${opts.script}`,
      '-f', `args_json=${JSON.stringify(opts.args)}`,
      '-f', `review_texts=${opts.reviewTexts}`,
      '-f', `review_texts_depth=${opts.reviewTextsDepth}`,
      '-f', `request_id=${requestId}`,
      '-f', `timeout_minutes=${opts.timeoutMin}`,
      '-f', `pubkey_b64=${Buffer.from(publicKey).toString('base64')}`]);
  } catch (err) {
    console.error(`Could not dispatch ${WORKFLOW}: ${(err.stderr || err.message || '').trim()}`);
    return 3;
  }
  console.error(`[cloud-run-script] dispatched ${opts.script} (request ${requestId}); waiting for the run...`);

  const run = findRun(requestId, Date.now() + 3 * 60 * 1000);
  if (!run) { console.error('[cloud-run-script] the run never appeared in the Actions list within 3 min.'); return 3; }
  console.error(`[cloud-run-script] run ${run.html_url}`);

  // Script limit plus npm ci and the data checkouts, counted from the run starting.
  let startedAt = null;
  let status = run.status;
  let conclusion = run.conclusion;
  while (status !== 'completed') {
    if (startedAt == null && status === 'in_progress') startedAt = Date.now();
    if (Date.now() > pollDeadline({ dispatchedAt, startedAt, timeoutMin: opts.timeoutMin, queueWaitMin: opts.queueWaitMin })) {
      const limit = startedAt == null ? `${opts.queueWaitMin} min queued` : `${opts.timeoutMin} min running`;
      console.error(`[cloud-run-script] still ${status} after ${limit}; follow it at ${run.html_url}`);
      return 3;
    }
    sleep(30000);
    const r = ghJson(`repos/${REPO}/actions/runs/${run.id}`);
    status = r.status;
    conclusion = r.conclusion;
  }

  const jobs = ghJson(`repos/${REPO}/actions/runs/${run.id}/jobs`).jobs || [];
  const job = jobs.find((j) => j.name === 'run') || jobs[0];
  let parsed = { found: false, output: '', exitCode: null };
  if (job) {
    try { parsed = extractOutput(require('./lib/land-retry-on-cancel.js').runGhWithFallback([`repos/${REPO}/actions/jobs/${job.id}/logs`], { exec: execFileSync })); } catch (err) {
      console.error(`[cloud-run-script] could not read the job log: ${(err.stderr || err.message || '').trim()}`);
    }
  }
  if (!parsed.found) {
    console.error(`[cloud-run-script] run ended ${conclusion} before the script printed anything; see ${run.html_url}`);
    return 3;
  }
  // The runner prints the sealed JSON in chunks; base64 never contains '*', so a
  // '*' means Actions masked a secret value that happened to occur in it.
  const blob = parsed.output.split('\n').join('').trim();
  if (blob.includes('*')) {
    console.error('[cloud-run-script] GitHub masked part of the encrypted output (a secret value occurred in it by chance); run it again.');
    return 3;
  }
  let text;
  try { text = open(JSON.parse(blob), privateKey); } catch (err) {
    console.error(`[cloud-run-script] could not decrypt the output: ${err.message}`);
    return 3;
  }
  process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  console.error(`[cloud-run-script] run ${conclusion}, script exit ${parsed.exitCode}`);
  return parsed.exitCode == null ? 3 : parsed.exitCode;
}

if (require.main === module) process.exit(main());

module.exports = { parseArgs, pollDeadline, extractOutput, validateScriptPath, stripTimestamp, BEGIN, END };
