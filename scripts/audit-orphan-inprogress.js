#!/usr/bin/env node
/**
 * audit-orphan-inprogress.js — the one-time triage driver for task #1705:
 * "finish the orphaned-task drain — 90 tasks still claimed with no session,
 * lost-vs-finished split never reported."
 *
 * Task #1691 fixed the DOMINANT cause of orphaned in_progress tasks (a
 * mirrored task whose Notion card already flipped to Done, invisible to
 * notion-tasks-sync's status-filtered pull) via `sync-drift`, draining
 * in_progress 197 -> 90. The remaining 90 are NOT explained by that class —
 * their Notion cards still read In progress/Not started/Paused, so sync-drift
 * has nothing to correct. This script does the per-card adjudication #1691's
 * card explicitly said was still owed: classify each into FINISHED / LOST /
 * STALE / NEEDS-REVIEW using scripts/lib/orphan-inprogress-triage.js's pure
 * decision tree, and (with --fix) apply the safe ones.
 *
 * Usage:
 *   node scripts/audit-orphan-inprogress.js              report only (default)
 *   node scripts/audit-orphan-inprogress.js --json        machine-readable report
 *   node scripts/audit-orphan-inprogress.js --fix [--dry-run]
 *
 * --fix actions, matching the established conventions (audit-archived-in-
 * progress.js, bsc-reconcile.js's sweepUntrackedInProgress):
 *   FINISHED      local status -> completed; Notion -> Done (if not already)
 *                 with the corroborating commit(s) noted.
 *   STALE         local status -> completed; Notion left as-is (already
 *                 terminal, or no card to correct).
 *   LOST          local status -> pending (reclaimed); Notion -> Not started
 *                 (if not already) with a note.
 *   NEEDS-REVIEW  untouched (stays in_progress) — these are the named,
 *                 justified survivors. A one-line idempotency marker is
 *                 prepended so a repeat run doesn't re-report the same card.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { dispatchedTaskIds, gitRefSources } = require('./audit-archived-in-progress.js');
const { taskBranchEvidence, notionMarkerOf } = require('./lib/task-reclaim.js');
const { classifyOrphanInProgress } = require('./lib/orphan-inprogress-triage.js');
const ledger = require('./lib/dispatch-ledger.js');
const cmuxws = require('./lib/cmux-workspaces.js');
const { foldDiacritics } = require('./lib/title-match');

const USAGE = `audit-orphan-inprogress.js — classify in_progress tasks with no live cmux workspace (task #1705).

Usage:
  node scripts/audit-orphan-inprogress.js            report (FINISHED/LOST/STALE/NEEDS-REVIEW split)
  node scripts/audit-orphan-inprogress.js --json      same, machine-readable
  node scripts/audit-orphan-inprogress.js --fix [--dry-run]   apply FINISHED/LOST/STALE, leave NEEDS-REVIEW
`;

if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const REPO = path.resolve(__dirname, '..');
const MARKER = '[orphan-triage-1705 ';

function tasksDir() {
  const listId = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
  return process.env.CLAUDE_CODE_TASKS_DIR || path.join(os.homedir(), '.claude', 'tasks', listId);
}

function loadLiveTasks(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((n) => /^\d+\.json$/.test(n))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ ...parsed, id: String(parsed.id ?? f.replace('.json', '')) });
    } catch { /* skip unparseable */ }
  }
  return out;
}

/** in_progress tasks whose title/subject matches no currently-listed cmux workspace. */
function findOrphans({ loadTasksFn = loadLiveTasks, dir = tasksDir(), listWorkspacesFn = cmuxws.listWorkspaces } = {}) {
  const tasks = loadTasksFn(dir).filter((t) => t.status === 'in_progress');
  let workspaces = [];
  try { workspaces = listWorkspacesFn() || []; } catch { /* cmux down — degrade to "no workspaces", the caller decides what to do with an all-orphan result */ }
  return tasks.filter((t) => !workspaces.some((w) => ledger.titleMatchesSubject(w.title, t.subject)));
}

/**
 * One pass over full git history, subjects only. A single process is far
 * cheaper than 90 separate `git log --grep` invocations (measured: ~1.3s each
 * vs ~1s total for the full log here) and gives every id a real word-boundary
 * match (`(?!\d)`) that git's own -E (POSIX ERE, no lookahead) cannot express.
 */
function buildGitEvidenceIndex(repoRoot) {
  let raw;
  try {
    raw = execFileSync('git', ['log', '--format=%H%x01%s', 'main'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch { return () => ({ hasEvidence: false, commits: [] }); }
  const lines = raw.split('\n').filter(Boolean);
  const cache = new Map();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const re = new RegExp(`#${id}(?!\\d)`);
    const commits = [];
    for (const line of lines) {
      const sep = line.indexOf('\x01');
      if (sep === -1) continue;
      const subject = line.slice(sep + 1);
      if (re.test(subject)) commits.push(`${line.slice(0, sep).slice(0, 10)} ${subject}`);
      if (commits.length >= 5) break; // enough to prove it; not building a full history
    }
    const result = { hasEvidence: commits.length > 0, commits };
    cache.set(id, result);
    return result;
  };
}

/**
 * Stronger-than-#id corroboration for a card's Outcome text: a keyFile that
 * actually exists on disk, or a commit hash near merge/landing language that
 * resolves to a real commit. See orphan-inprogress-triage.js's jsdoc on why
 * this exists — card #1159 in the real backlog is a genuinely finished task
 * whose Outcome names commit 46bc0384 and 3 real keyFiles, but whose commit
 * message never contains "#1159" (its own title cites a different tracker's
 * "card #1158"), so a plain #id grep alone misses it.
 */
function buildOutcomeCorroborator(repoRoot) {
  const commitCache = new Map();
  const commitExists = (hash) => {
    if (commitCache.has(hash)) return commitCache.get(hash);
    let ok = false;
    try {
      const t = execFileSync('git', ['cat-file', '-t', hash], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      ok = t === 'commit';
    } catch { ok = false; }
    commitCache.set(hash, ok);
    return ok;
  };

  // A hex-hash TOKEN preceded (within 3 words) by one of these — deliberately
  // not an exact connector-word regex (measured on the real backlog, card
  // #1161: the same card writes both "commit 052dcb80484" AND "merged to
  // main AS 3b8e9c01856" — an "at"-only phrase regex missed the second form
  // outright). An unanchored bare hex scan is still avoided (it would match
  // line numbers, timestamps, "deed"/"beefed") by requiring one of these
  // words nearby, not by pinning the exact grammar between them.
  const ANCHOR_WORDS = new Set(['commit', 'merged', 'squash-merged', 'landed', 'pushed', 'sha', 'origin']);
  const strip = (w) => foldDiacritics(w).toLowerCase().replace(/[^a-z0-9-]/g, '');

  return (card) => {
    const evidence = [];
    // keyFiles is free-text prose as often as it is a path list (card #1161:
    // "commit 052dcb80484: fix classification...; merged to main as
    // 3b8e9c01856" — no slash in sight), so it is scanned for hashes exactly
    // like outcome/notes, not just mined for paths below.
    const text = `${card.outcome || ''}\n${card.notes || ''}\n${card.keyFiles || ''}`;
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const hash = words[i].replace(/[^0-9a-f]/gi, '');
      // Minimum 8, not git's usual 7 (ship-check adversarial catch, task
      // #1705): `git cat-file -t` resolves a short hex string as a PREFIX
      // match, so in a 200k+-commit repo a 7-char token has real collision
      // odds of accidentally resolving to some UNRELATED commit and reading
      // as corroboration. Every real hash observed in the actual backlog
      // this was built against was 8-11 chars (git's own auto-abbreviation
      // length), so 8 costs nothing in practice while cutting the riskiest case.
      if (!/^[0-9a-f]{8,40}$/i.test(hash)) continue;
      const windowStart = Math.max(0, i - 3);
      const nearAnchor = words.slice(windowStart, i).some((w) => ANCHOR_WORDS.has(strip(w)));
      if (!nearAnchor) continue;
      if (commitExists(hash)) evidence.push(`commit ${hash} exists`);
    }
    const keyFiles = String(card.keyFiles || '').split(',').map((s) => s.trim()).filter((s) => s.includes('/'));
    for (const kf of keyFiles) {
      const p = path.join(repoRoot, kf);
      if (fs.existsSync(p)) evidence.push(`keyFile ${kf} exists`);
    }
    return { hasEvidence: evidence.length > 0, evidence: [...new Set(evidence)] };
  };
}

function fetchCard(notionId) {
  const r = spawnSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', notionId], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function correctCard(notionId, note, status) {
  const r = spawnSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'update', notionId, '--status', status, '--outcome', note], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0;
}

function writeVerified(destPath, body) {
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, destPath);
  return fs.readFileSync(destPath, 'utf8') === body;
}

function applyDecision(decision, { dir, now, dryRun, cardOfCache }) {
  const id = decision.id;
  const file = path.join(dir, `${id}.json`);
  let task;
  try { task = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { id, done: false, why: 'task file vanished mid-run' }; }
  if (task.status !== 'in_progress') return { id, done: false, why: `no longer in_progress (now ${task.status})` };

  if (decision.bucket === 'NEEDS-REVIEW') {
    if (dryRun) return { id, done: true, action: 'left-in-progress' };
    if (String(task.description || '').includes(MARKER)) return { id, done: true, action: 'already-marked' };
    task.description = `${MARKER}${new Date(now).toISOString().slice(0, 10)}] ${decision.action}: ${decision.reason}\n\n${task.description || ''}`;
    const body = `${JSON.stringify(task, null, 2)}\n`;
    if (!writeVerified(file, body)) return { id, done: false, why: 'read-back mismatch' };
    return { id, done: true, action: 'marked-needs-review' };
  }

  if (decision.bucket === 'FINISHED') {
    if (dryRun) return { id, done: true, action: 'would-complete' };
    task.status = 'completed';
    task.orphanTriageResolvedAt = new Date(now).toISOString();
    task.orphanTriageReason = decision.reason;
    const body = `${JSON.stringify(task, null, 2)}\n`;
    if (!writeVerified(file, body)) return { id, done: false, why: 'read-back mismatch' };
    let cardCorrected = null;
    if (decision.notionId && decision.cardStatus !== 'Done') {
      const evidence = (decision.commits || []).slice(0, 3).join('\n');
      const note = `Auto-closed ${new Date(now).toISOString().slice(0, 10)} by audit-orphan-inprogress.js --fix (task #1705): task sat in_progress with no live session; verified finished — ${decision.reason}.${evidence ? `\n\nEvidence:\n${evidence}` : ''}`;
      cardCorrected = correctCard(decision.notionId, note, 'Done');
    }
    return { id, done: true, action: 'completed-finished', cardCorrected };
  }

  if (decision.bucket === 'STALE') {
    if (dryRun) return { id, done: true, action: 'would-close-stale' };
    task.status = 'completed';
    task.orphanTriageResolvedAt = new Date(now).toISOString();
    task.orphanTriageReason = decision.reason;
    const body = `${JSON.stringify(task, null, 2)}\n`;
    if (!writeVerified(file, body)) return { id, done: false, why: 'read-back mismatch' };
    let cardCorrected = null;
    // card-terminal (already Archived/Cancelled) and close-superseded (BSC
    // Daily, usually no card at all) need no Notion write — the card already
    // says what the local mirror now also says. card-duplicate/card-superseded
    // is different: those cards were sitting at Paused (the #1272 "needs a
    // human yes/no" convention), and this triage IS that human's answer —
    // leaving them at Paused forever would dangle the exact signal it exists
    // to resolve.
    if (decision.action === 'card-superseded' && decision.notionId && decision.cardStatus !== 'Archived') {
      const note = `Auto-archived ${new Date(now).toISOString().slice(0, 10)} by audit-orphan-inprogress.js --fix (task #1705): ${decision.reason}.`;
      cardCorrected = correctCard(decision.notionId, note, 'Archived');
    }
    return { id, done: true, action: 'completed-stale', cardCorrected };
  }

  // LOST -> reclaim to pending, matching reclaimedTaskShape's convention.
  if (dryRun) return { id, done: true, action: 'would-reclaim' };
  task.status = 'pending';
  task.owner = null;
  task.orphanTriageReclaimedAt = new Date(now).toISOString();
  task.orphanTriageReason = decision.reason;
  const body = `${JSON.stringify(task, null, 2)}\n`;
  if (!writeVerified(file, body)) return { id, done: false, why: 'read-back mismatch' };
  let cardCorrected = null;
  if (decision.notionId && decision.cardStatus !== 'Not started') {
    const note = `Auto-reopened ${new Date(now).toISOString().slice(0, 10)} by audit-orphan-inprogress.js --fix (task #1705): task sat in_progress with no live session, no dispatch-ledger start event, and no recorded Outcome — no evidence any work happened. Re-eligible for dispatch.`;
    cardCorrected = correctCard(decision.notionId, note, 'Not started');
  }
  return { id, done: true, action: 'reclaimed-lost', cardCorrected };
}

function run(argv) {
  const dir = tasksDir();
  const orphans = findOrphans({ dir });
  // dispatchedTaskIds returns null (not []) when dispatch-ledger.jsonl is
  // unreadable — gitignored, so absent by construction in a git worktree
  // (audit-archived-in-progress.js's own docstring: "absent input must read
  // as 'cannot answer', never as 'answer is zero'"). ship-check adversarial
  // review (task #1705) caught this exact bug live: run from a worktree, the
  // `|| new Set()` fallback silently made EVERY task look never-dispatched,
  // and task #57 — which had real launch/job-spawned/job-done ledger
  // history in the main checkout — got reclaimed to LOST/pending on that
  // false "never started" basis. Refuse rather than mislead, matching
  // audit-archived-in-progress.js's main()'s exit-2 convention exactly.
  const startedIdsRaw = dispatchedTaskIds(REPO);
  if (startedIdsRaw === null) {
    const msg = `dispatch-ledger.jsonl not readable at ${path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl')}\n`
      + '  It is gitignored, so it does not exist in a git worktree. Re-run from the main checkout\n'
      + '  (/Users/tompryor/Broadwayscore). Refusing to classify: with no ledger every task would\n'
      + '  look never-started, which is a wrong answer, not a cautious one.';
    if (argv.includes('--json')) console.log(JSON.stringify({ error: msg }, null, 2));
    else console.error(`[audit-orphan-inprogress] REFUSED — ${msg}`);
    process.exitCode = 2;
    return null;
  }
  const startedIds = startedIdsRaw;
  const { branches, worktreePaths } = gitRefSources(REPO);
  const gitEvidenceOf = buildGitEvidenceIndex(REPO);
  const cardCache = new Map();
  const cardOf = (notionId) => {
    if (cardCache.has(notionId)) return cardCache.get(notionId);
    const card = fetchCard(notionId);
    cardCache.set(notionId, card);
    return card;
  };

  const decisions = classifyOrphanInProgress(orphans, {
    startedIds,
    branchEvidenceOf: (id) => taskBranchEvidence(id, { branches, worktreePaths }),
    gitEvidenceOf,
    corroborateOutcomeOf: buildOutcomeCorroborator(REPO),
    cardOf,
    now: Date.now(),
  });

  const buckets = { FINISHED: [], LOST: [], STALE: [], 'NEEDS-REVIEW': [] };
  for (const d of decisions) buckets[d.bucket].push(d);

  if (argv.includes('--fix')) {
    const dryRun = argv.includes('--dry-run');
    const results = decisions.map((d) => applyDecision(d, { dir, now: Date.now(), dryRun }));
    console.log(JSON.stringify({ dryRun, results }, null, 2));
    return { orphans, decisions, buckets, results };
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ total: orphans.length, buckets }, null, 2));
    return { orphans, decisions, buckets };
  }

  console.log(`[audit-orphan-inprogress] ${orphans.length} in_progress task(s) with no live workspace`);
  for (const bucket of ['FINISHED', 'STALE', 'LOST', 'NEEDS-REVIEW']) {
    console.log(`\n${bucket}: ${buckets[bucket].length}`);
    for (const d of buckets[bucket]) console.log(`  #${d.id} [${d.action}] ${d.subject.slice(0, 70)} — ${d.reason}`);
  }
  return { orphans, decisions, buckets };
}

if (require.main === module) run(process.argv.slice(2));

module.exports = { run, findOrphans, loadLiveTasks, tasksDir, buildGitEvidenceIndex, applyDecision, writeVerified, MARKER };
