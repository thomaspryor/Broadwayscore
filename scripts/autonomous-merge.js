#!/usr/bin/env node
/**
 * autonomous-merge.js — CI-side merge/revert executor for the autonomous
 * nightly loop (Sprint 3: S3-T1 merge, S3-T2 oscillation breaker, S3-T3
 * revert). Invoked by .github/workflows/autonomous-merge.yml via
 * workflow_dispatch — this is the ONLY place a branch the loop produced
 * reaches main; the Mac Studio executor only ever pushes `auto/*` branches.
 *
 *   node scripts/autonomous-merge.js --card <notion-id> --branch <name> --action approve|revert
 *
 * approve: rebase the branch onto origin/main → re-run tsc + colocated tests
 *   + the card's checkableDone (fetched from a Notion comment — the
 *   executor's own ledger is Mac-Studio-local, unreachable from GitHub
 *   Actions) → eligibility gate on the REBASED diff → oscillation check
 *   (git history on main, NOT the ledger — see scripts/lib/autonomous-merge-core.js)
 *   → merge via scripts/lib/push-with-retry.sh → Auto=merged, Status=Done,
 *   evidence on the card. ANY failure strips the approval (Auto→needs-approval,
 *   scripts/lib/autonomous-state.js merge.reverify-fail) — a fresh tap is
 *   required to try again; the branch itself is left untouched.
 *
 * revert: only legal from Auto=merged. Locates the merge commit by its
 *   "Auto-merge-card: <id>" trailer, `git revert`s it, pushes, reopens the card.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const { transition } = require('./lib/autonomous-state.js');
const { isDiffAllowed } = require('./lib/autonomous-eligibility.js');
const { decideChecks, cardCheckArgv } = require('./lib/autonomous-run-core.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { latestEvidenceForBranch } = require('./lib/autonomous-notion-evidence.js');
const {
  oscillationTrailerFor, shouldEscalateOscillation, buildEscalationNote,
  buildMergeOutcomeNote, buildReverifyFailNote, buildRevertOutcomeNote,
} = require('./lib/autonomous-merge-core.js');

const REPO = path.join(__dirname, '..');
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { a[t.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function gitOrNull(args) {
  try { return git(args); } catch { return null; }
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

function notionUpdate(id, flags) {
  execFileSync('node', [path.join(__dirname, 'notion-brain.js'), 'update', id, ...flags], {
    cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
  });
}

function httpsJson(method, hostname, apiPath, headers, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname, path: apiPath, method,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 15000,
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (data) req.write(data);
    req.end();
  });
}

async function fetchEvidenceForBranch(cardId, branch) {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return null;
  const res = await httpsJson('GET', 'api.notion.com', `/v1/comments?block_id=${encodeURIComponent(cardId)}&page_size=100`,
    { Authorization: `Bearer ${notionKey}`, 'Notion-Version': '2022-06-28' });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.results)) return null;
  return latestEvidenceForBranch(res.json.results, branch);
}

// Rule 17: transactional only, direct POST to one explicit owner address —
// never a broadcast/audience endpoint. Fail-soft: never crashes the merge run.
async function sendEscalationEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.OWNER_EMAIL;
  if (!apiKey || !to) { console.error('[merge] WARN cannot send escalation email (missing RESEND_API_KEY or OWNER_EMAIL)'); return; }
  const res = await httpsJson('POST', 'api.resend.com', '/emails', { Authorization: `Bearer ${apiKey}` }, {
    from: 'Broadway Scorecard <alerts@broadwayscorecard.com>', to: [to], subject,
    html: `<pre style="white-space:pre-wrap;font-family:-apple-system,sans-serif;">${text}</pre>`,
  });
  if (res.status < 200 || res.status >= 300) console.error(`[merge] WARN escalation email send failed: ${res.status}`);
}

function runChecks(files, checkableDone) {
  const results = [];
  const checks = decideChecks(files, f => fs.existsSync(path.join(REPO, f)));
  const cardArgv = cardCheckArgv(checkableDone, isSafeCheckCommand);
  if (cardArgv) checks.push({ name: `card-check (${checkableDone})`, argv: cardArgv });
  for (const c of checks) {
    try {
      execFileSync(c.argv[0], c.argv.slice(1), { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS, encoding: 'utf8' });
      results.push({ name: c.name, pass: true });
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) });
    }
  }
  return results;
}

function pushMain() {
  execFileSync('bash', [path.join(__dirname, 'lib', 'push-with-retry.sh'), '7', 'main'], { cwd: REPO, stdio: 'inherit' });
}

async function approve(cardId, branch) {
  const card = notionBrain(['get', cardId]);
  if (card.auto !== 'approved') {
    console.log(`[merge] card ${cardId} is Auto=${card.auto || 'none'}, not 'approved' — nothing to do (state moved underneath us, or already handled)`);
    return;
  }

  // Oscillation breaker (S3-T2): git history on main, not the (Mac-local,
  // unreachable-from-CI) ledger — see scripts/lib/autonomous-merge-core.js.
  git(['fetch', 'origin', 'main']);
  const trailer = oscillationTrailerFor(cardId);
  const priorMerges = (gitOrNull(['log', '--fixed-strings', '--grep', trailer, '--format=%H', 'origin/main']) || '').trim().split('\n').filter(Boolean).length;
  if (shouldEscalateOscillation(priorMerges)) {
    transition('approved', 'merge.oscillation');
    notionUpdate(cardId, ['--auto', 'failed', '--outcome', buildEscalationNote(cardId, priorMerges)]);
    await sendEscalationEmail(`⚠️ Autonomous loop: "${card.name}" already merged ${priorMerges}x — refusing`, buildEscalationNote(cardId, priorMerges));
    console.error(`[merge] OSCILLATION: card ${cardId} already merged ${priorMerges} time(s) — refusing, escalated to owner`);
    process.exitCode = 1;
    return;
  }

  const reverifyFail = (reason) => {
    transition('approved', 'merge.reverify-fail');
    notionUpdate(cardId, ['--auto', 'needs-approval', '--outcome', buildReverifyFailNote(reason)]);
    console.error(`[merge] RE-VERIFY FAILED: ${reason}`);
    process.exitCode = 1;
  };

  git(['fetch', 'origin', branch]);
  git(['checkout', '-B', 'auto-merge-work', `origin/${branch}`]);
  try {
    git(['rebase', 'origin/main']);
  } catch (err) {
    gitOrNull(['rebase', '--abort']);
    reverifyFail(`branch ${branch} would not rebase cleanly onto origin/main: ${String(err.message).slice(0, 300)}`);
    return;
  }

  const files = git(['diff', '--name-only', 'origin/main...HEAD']).trim().split('\n').filter(Boolean);
  if (!files.length) { reverifyFail('rebased diff is empty — nothing to merge'); return; }
  const gate = isDiffAllowed(files);
  if (!gate.allowed) { reverifyFail(`rebased diff touches ineligible paths: ${gate.refused.join(', ')}`); return; }

  const evidence = await fetchEvidenceForBranch(cardId, branch);
  if (!evidence) console.error('[merge] WARN no Notion evidence comment found for this branch — re-verifying with tsc + colocated tests only (no card-specific check)');
  const checks = runChecks(files, evidence ? evidence.checkableDone : null);
  const failed = checks.filter(c => !c.pass);
  if (failed.length) {
    reverifyFail(failed.map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 500));
    return;
  }

  // Stamp the oscillation trailer on the last commit before merging.
  const priorMsg = git(['log', '-1', '--pretty=%B']).trim();
  git(['commit', '--amend', '-m', `${priorMsg}\n\n${trailer}`]);
  const sha = git(['rev-parse', 'HEAD']).trim();

  git(['checkout', 'main']);
  git(['reset', '--hard', 'origin/main']);
  let merged = false;
  for (let i = 0; i < 2 && !merged; i++) {
    try { git(['merge', '--ff-only', 'auto-merge-work']); merged = true; }
    catch {
      if (i === 0) {
        git(['fetch', 'origin', 'main']);
        git(['checkout', 'auto-merge-work']);
        try { git(['rebase', 'origin/main']); } catch { break; }
        git(['checkout', 'main']);
        git(['reset', '--hard', 'origin/main']);
      }
    }
  }
  if (!merged) { reverifyFail('main advanced during the merge window and a clean fast-forward was not possible after one retry'); return; }

  pushMain();

  transition('approved', 'merge.success');
  notionUpdate(cardId, ['--auto', 'merged', '--status', 'Done', '--outcome', buildMergeOutcomeNote({ sha, branch, files })]);
  console.log(`[merge] MERGED card ${cardId} (${sha}) from ${branch}`);
}

async function revert(cardId, branch) {
  const card = notionBrain(['get', cardId]);
  if (card.auto !== 'merged') {
    console.log(`[merge] card ${cardId} is Auto=${card.auto || 'none'}, not 'merged' — nothing to revert`);
    return;
  }
  git(['fetch', 'origin', 'main']);
  const trailer = oscillationTrailerFor(cardId);
  const mergeSha = (gitOrNull(['log', '--fixed-strings', '--grep', trailer, '--format=%H', '-1', 'origin/main']) || '').trim();
  if (!mergeSha) {
    console.error(`[merge] REVERT FAILED: no commit on origin/main carries "${trailer}" — cannot safely locate the merge to revert`);
    process.exitCode = 1;
    return;
  }
  git(['checkout', 'main']);
  git(['reset', '--hard', 'origin/main']);
  let revertSha;
  try {
    git(['revert', '--no-edit', mergeSha]);
    revertSha = git(['rev-parse', 'HEAD']).trim();
  } catch (err) {
    gitOrNull(['revert', '--abort']);
    console.error(`[merge] REVERT FAILED: git revert ${mergeSha} conflicted (later commits touched the same lines): ${String(err.message).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  pushMain();
  transition('merged', 'tap.revert');
  notionUpdate(cardId, ['--auto', 'reverted', '--status', 'Not started', '--outcome', buildRevertOutcomeNote({ revertSha, mergeSha })]);
  console.log(`[merge] REVERTED card ${cardId}: ${mergeSha} → ${revertSha}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cardId = args.card;
  const branch = args.branch;
  const action = args.action;
  if (!cardId || !branch || !['approve', 'revert'].includes(action)) {
    console.error('usage: node scripts/autonomous-merge.js --card <id> --branch <name> --action approve|revert');
    process.exit(2);
  }
  if (action === 'approve') await approve(cardId, branch);
  else await revert(cardId, branch);
}

if (require.main === module) {
  main().catch(err => { console.error(`[merge] fatal: ${err.message}`); process.exit(1); });
}

module.exports = { approve, revert };
