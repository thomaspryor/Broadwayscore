#!/usr/bin/env node
/**
 * reclassify-headless-endings.js — BRO-4066 Gap 2: BRO-4064 fixed
 * classifyHeadlessResult() to recognize the plain-English "You can close
 * this tab." / "Keep this tab open." templates a headless job's own
 * `res.resultText` carries now (owner escalation BRO-3914 moved every
 * session's chat text to plain English; see headless-result-classifier.js's
 * header). Its own description promised a backfill row per already-affected
 * job where the landing is provable, item 3, but that was never built — 48
 * job-stopped-short rows since 2026-09-20 carry the OLD default
 * misclassification ('no THIS SESSION: status line in final result') even
 * though several of those jobs' work genuinely landed.
 *
 * This script re-classifies each one with the NEW classifier
 * (classifyHeadlessJobResult, which also prefers the session's own recorded
 * wrapup-block over resultText) and, for the ones that now read 'clean',
 * looks for proof the work reached origin/main:
 *   1. detectJobLanding() against the job's OWN worktree cwd (from its
 *      job-spawned row) — direct ancestry, the strongest evidence. Usually
 *      unavailable by the time this runs: bsc-runner's teardownJobWorktree
 *      deletes a clean, non-ahead-of-origin/main worktree unconditionally
 *      (a landed job's HEAD is folded into origin/main, so `ahead` reads 0
 *      and the worktree is gone within the same run).
 *   2. A fallback `git log --grep=<ref>` search on origin/main within the
 *      job's own dispatch window — weaker (a substring/near-miss match), so
 *      it additionally requires the Linear card to be Done/In Review AND
 *      carry a session-report comment before being trusted at all.
 *
 * It never writes the ledger itself: it hands each candidate (ref, sha,
 * jobId, verifyCmd, reason) to scripts/ack-landed.js — the SAME writer, with
 * every one of its own re-verification preconditions (fresh origin/main
 * fetch, sha tied to the job's own window, safe-form verify command
 * actually exits 0) still enforced. BRO-4066 Gap 1's --job-id flag is what
 * makes this possible: without it, ack-landed.js would evaluate every
 * precondition against the ref's LATEST ledger row, not this specific
 * historical job.
 *
 * --dry-run (default): prints what WOULD be attempted, writes nothing.
 * --apply: actually runs ack-landed.js for each qualifying candidate.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const ledger = require('./lib/dispatch-ledger.js');
const { parseStreamLine } = require('./lib/claude-cli.js');
const { classifyHeadlessJobResult } = require('./lib/headless-wrapup-block.js');
const { detectJobLanding } = require('./lib/headless-unlanded-detection.js');
const { extractVerifyCmd } = require('./lib/autonomous-verify-cmd.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { getIssue } = require('./lib/linear-client.js');
const { parseSessionReportStatus } = require('./lib/linear-session-reporting.js');

const REPO = '/Users/tompryor/Broadwayscore';
const DEFAULT_REASON = 'no THIS SESSION: status line in final result';
const DEFAULT_SINCE = '2026-09-20T00:00:00.000Z';
// Padding around the job's own [spawn, terminal] window for the git-log
// fallback search — a WIDE net is fine here because ack-landed.js's own
// decideAck re-derives the precise author-date window from the sha itself
// and refuses anything outside it; this only decides which sha to OFFER it.
const SEARCH_WINDOW_PAD_MS = 30 * 60 * 1000;

const USAGE = `reclassify-headless-endings.js — BRO-4066 backfill: re-classify job-stopped-short rows misclassified by the OLD (pre-BRO-4064) classifier, and ack the ones now provably clean+landed.

Usage:
  node scripts/reclassify-headless-endings.js [--dry-run|--apply] [--since <ISO8601>] [--no-linear]

  --dry-run     default. Prints the candidate table, writes nothing.
  --apply       actually runs scripts/ack-landed.js for each qualifying row.
  --since       only consider job-stopped-short rows at/after this ts
                (default ${DEFAULT_SINCE}).
  --no-linear   passed through to ack-landed.js (skip its Linear comment).
`;

function parseArgs(argv) {
  const out = { apply: false, since: DEFAULT_SINCE, noLinear: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--apply': out.apply = true; break;
      case '--dry-run': out.apply = false; break;
      case '--no-linear': out.noLinear = true; break;
      case '--since': out.since = argv[++i]; break;
      default:
        return { error: `unknown argument: ${a}` };
    }
  }
  return out;
}

function refFromTaskId(taskId) {
  const m = /^(?:linear:)?(BRO-\d+)$/i.exec(String(taskId || '').trim());
  return m ? m[1].toUpperCase() : null;
}

// The job's own final result text, reconstructed from its stream-json log
// (the same shape bsc-runner.js parses live via parseStreamLine) — the last
// 'result' event's resultText, matching what bsc-runner passed to the
// classifier at the time. Never throws; a missing/unreadable log degrades to
// '' (classifyHeadlessJobResult still works off the recorded wrapup-block
// alone in that case).
function readLastResultText(logFile) {
  if (!logFile) return '';
  let raw;
  try { raw = fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
  let last = '';
  for (const line of raw.split('\n')) {
    const ev = parseStreamLine(line);
    if (ev && ev.result && typeof ev.result.resultText === 'string') last = ev.result.resultText;
  }
  return last;
}

// Last row per jobId in file order (append-only ledger, so "last in file
// order" is "most recent"). Used to skip a candidate whose jobId already has
// a later row (an existing landed-acked, a resume's job-retried, etc.) —
// something else already handled it.
function lastRowByJobId(entries) {
  const m = new Map();
  for (const e of entries) {
    if (e && e.jobId) m.set(e.jobId, e);
  }
  return m;
}

function findSpawn(entries, jobId) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.event === 'job-spawned' && e.jobId === jobId) return e;
  }
  return null;
}

// job-stopped-short rows matching the OLD-classifier default reason, at/after
// `sinceMs`, whose jobId has had NOTHING appended after them (still the raw,
// unhandled misclassification this backfill exists for).
function candidateRows(entries, sinceMs, lastByJob) {
  const out = [];
  for (const e of entries) {
    if (!e || e.event !== 'job-stopped-short' || e.reason !== DEFAULT_REASON) continue;
    const ts = Date.parse(e.ts || '');
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    if (lastByJob.get(e.jobId) !== e) continue; // superseded — already handled
    out.push(e);
  }
  return out;
}

function gitLogRefSearch(ref, sinceIso, untilIso) {
  try {
    const out = execFileSync('git', [
      '-C', REPO, 'log', 'origin/main',
      `--since=${sinceIso}`, `--until=${untilIso}`,
      '--fixed-strings', `--grep=${ref}`, '--format=%H',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const lines = out.split('\n').filter(Boolean);
    return lines[0] || null; // git log's default order is newest-first
  } catch {
    return null;
  }
}

// Corroboration for the WEAKER git-log-search evidence path: a session that
// self-reported done/in-review via linear-session.js's `report` command (the
// SESSION_REPORT_PREFIX comment, parsed for its own recorded status), or the
// card's CURRENT state already reading Done/In Review. Deliberately an OR,
// not "current state only" — reconcile-dead-completions can auto-reopen a
// card back to Todo off a bad ledger row (the exact class of bug BRO-4066
// exists to fix: verified live against BRO-3227, whose card sits at "Todo"
// despite two "Session report (done)" comments describing work landed to
// main), so requiring the mutable current state alone would make this check
// fail on precisely the cards this backfill is for.
function hasSessionReportComment(issue) {
  const nodes = (issue && issue.comments && issue.comments.nodes) || [];
  return nodes.some((c) => {
    const status = parseSessionReportStatus(c && c.body);
    return status === 'done' || status === 'in-review';
  });
}

function isDoneOrInReview(issue) {
  const state = issue && issue.state;
  if (!state) return false;
  if (state.type === 'completed') return true;
  return /in review/i.test(String(state.name || ''));
}

// Ship-check + Codex adversarial review (BRO-4066): the git-log-search
// fallback below can only tell "a commit naming this ref landed in this
// time window" — it cannot tell WHICH dispatch attempt on the same card
// produced it. Two attempts on the same card with overlapping activity (a
// re-dispatch that started before this job's own search window closes, or
// vice versa) could otherwise have this job's search window silently credit
// a SIBLING attempt's commit. detectJobLanding's cwd-ancestry path doesn't
// need this guard — it reads THIS job's own worktree HEAD, not a text
// search — but the weaker fallback does. Fails closed: any ledger activity
// from a DIFFERENT jobId on the same taskId inside [sinceMs, untilMs] makes
// the window ambiguous, full stop.
function hasOverlappingSiblingJob(entries, taskId, jobId, sinceMs, untilMs) {
  for (const e of entries) {
    if (!e || e.jobId === jobId || e.taskId !== taskId) continue;
    const ts = Date.parse(e.ts || '');
    if (Number.isFinite(ts) && ts >= sinceMs && ts <= untilMs) return true;
  }
  return false;
}

async function classifyAndFindLanding(row, spawn, entries) {
  const resultText = readLastResultText(spawn.logFile);
  const sessionId = row.sessionId || spawn.sessionId || null;
  const classified = classifyHeadlessJobResult({ resultText, sessionId, cwd: spawn.cwd });
  if (classified.outcome !== 'clean') {
    return { skip: `still ${classified.outcome} under the new classifier (source=${classified.source})` };
  }

  const landing = detectJobLanding({ cwd: spawn.cwd });
  if (landing.status === 'landed' && landing.sha) {
    return { classified, sha: landing.sha, evidence: 'detectJobLanding:cwd-ancestry' };
  }

  const ref = refFromTaskId(row.taskId);
  const sinceIso = spawn.ts;
  const untilIso = new Date(Date.parse(row.ts) + SEARCH_WINDOW_PAD_MS).toISOString();
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  if (hasOverlappingSiblingJob(entries, row.taskId, row.jobId, sinceMs, untilMs)) {
    return { skip: 'ambiguous: another dispatch attempt on the same card has ledger activity inside this job\'s search window — cannot safely attribute a git-log match to this specific job' };
  }
  const candidateSha = gitLogRefSearch(ref, sinceIso, untilIso);
  if (!candidateSha) {
    return { skip: 'no landing evidence (worktree gone, no matching commit on origin/main in the job window)' };
  }

  let issue = null;
  try { issue = await getIssue(ref); } catch (e) { return { skip: `Linear fetch failed: ${e.message}` }; }
  if (!issue) return { skip: 'Linear issue not found' };
  if (!isDoneOrInReview(issue) && !hasSessionReportComment(issue)) {
    return { skip: 'weak evidence (git-log-only match) not corroborated by a Done/In Review card or a done/in-review session report' };
  }
  return { classified, sha: candidateSha, evidence: 'git-log-ref-search+linear-corroboration', issue };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) { console.error(`--since is not a valid ISO8601 timestamp: ${args.since}`); process.exit(2); }

  const entries = ledger.readEntries();
  const lastByJob = lastRowByJobId(entries);
  const candidates = candidateRows(entries, sinceMs, lastByJob);
  console.error(`→ ${candidates.length} job-stopped-short row(s) since ${args.since} still carry the default reason and are unhandled.`);

  const table = [];
  for (const row of candidates) {
    const ref = refFromTaskId(row.taskId);
    if (!ref) { table.push({ ref: row.taskId, jobId: row.jobId, action: 'skip', detail: 'taskId is not a linear:BRO-N ref' }); continue; }
    const spawn = findSpawn(entries, row.jobId);
    if (!spawn) { table.push({ ref, jobId: row.jobId, action: 'skip', detail: 'no job-spawned row found for this jobId' }); continue; }

    let result;
    try { result = await classifyAndFindLanding(row, spawn, entries); }
    catch (e) { table.push({ ref, jobId: row.jobId, action: 'skip', detail: `error: ${e.message}` }); continue; }
    if (result.skip) { table.push({ ref, jobId: row.jobId, action: 'skip', detail: result.skip }); continue; }

    const issue = result.issue || (await getIssue(ref).catch(() => null));
    const ext = issue ? extractVerifyCmd(issue.description, isSafeCheckCommand, explainUnsafeCheckCommand) : { cmd: null, reason: 'could not fetch card' };
    if (!ext.cmd) { table.push({ ref, jobId: row.jobId, action: 'skip', detail: `no safe-form VERIFY command on the card (${ext.reason})` }); continue; }

    const reasonText = `reclassify-headless-endings backfill (BRO-4066): the BRO-4064 classifier reads this job's own wrapup-block/result as clean (source=${result.classified.source}), and ${result.evidence} confirms the work reached origin/main.`;

    if (!args.apply) {
      table.push({ ref, jobId: row.jobId, action: 'would-ack', detail: `sha=${result.sha.slice(0, 11)} evidence=${result.evidence} verify="${ext.cmd}"` });
      continue;
    }

    // Absolute path to THIS repo's own copy of ack-landed.js, not
    // `${REPO}/scripts/ack-landed.js` — BRO-4066 Gap 1 (--job-id) may not be
    // merged to main yet, and ack-landed.js's own REPO constant is hardcoded
    // absolute regardless of invocation cwd, so running it from wherever
    // this script lives is safe and picks up --job-id support.
    const ackScript = path.join(__dirname, 'ack-landed.js');
    const ackArgs = [ackScript, '--id', ref, '--sha', result.sha, '--job-id', row.jobId, '--verify', ext.cmd, '--reason', reasonText];
    if (args.noLinear) ackArgs.push('--no-linear');
    const res = spawnSync('node', ackArgs, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
    if (res.status === 0) {
      table.push({ ref, jobId: row.jobId, action: 'acked', detail: String(res.stdout || '').trim().split('\n').pop() });
    } else {
      const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      table.push({ ref, jobId: row.jobId, action: 'refused', detail: tail });
    }
  }

  printTable(table, args.apply);
}

function printTable(rows, applied) {
  console.log('');
  console.log(`| ref | jobId | action | detail |`);
  console.log(`|---|---|---|---|`);
  for (const r of rows) {
    console.log(`| ${r.ref} | ${r.jobId} | ${r.action} | ${String(r.detail || '').replace(/\|/g, '\\|')} |`);
  }
  console.log('');
  const counts = rows.reduce((acc, r) => { acc[r.action] = (acc[r.action] || 0) + 1; return acc; }, {});
  console.log(`Summary (${applied ? '--apply' : '--dry-run'}): ${JSON.stringify(counts)}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  parseArgs, refFromTaskId, candidateRows, lastRowByJobId, gitLogRefSearch,
  hasSessionReportComment, isDoneOrInReview, readLastResultText, findSpawn,
  hasOverlappingSiblingJob,
};
