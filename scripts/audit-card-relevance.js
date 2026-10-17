#!/usr/bin/env node
/**
 * audit-card-relevance.js — sweep the open-P1 pool for relevance (task #1719).
 *
 * Companion to scripts/audit-card-verifiability.js: that script asks "would
 * bsc-next dispatch this card?" (a shape check on its acceptance criteria).
 * This one asks "is this card's work still needed at all?" — and hand-
 * adjudicating the 5 oldest Paused P1s on 2026-08-16 found 3 of 5 were
 * finished or misfiled work still sitting open, which is why this exists.
 *
 * SHADOW MODE, permanently in this first pass: read-only, never touches
 * Notion. Verdicts are evidence for a human to act on, not an auto-close —
 * see scripts/lib/audit-card-relevance.js's header for the full rationale.
 *
 * Usage:
 *   node scripts/audit-card-relevance.js [--priority "P1 Next"] [--status "Not started,In progress,Paused"] [--limit N]
 *   node scripts/audit-card-relevance.js --skip-checkout   # skip the acceptance-command / commit-ancestry checks
 *                                                            (title/file-symbol/stale-file checks still run — fast, offline)
 *   node scripts/audit-card-relevance.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const { classifyPool } = require('./lib/audit-card-relevance.js');
const { makeFreshCheckout, removeCheckout, runVerify } = require('./lib/acceptance-check-core.js');
const { repoDepthArgs } = require('./lib/shallow-fetch-args.js');

const REPO = path.join(__dirname, '..');
const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const REPORT_PATH = path.join(AUDIT_DIR, 'card-relevance-audit.json');
const SNAPSHOT_PATH = path.join(AUDIT_DIR, 'card-relevance-digest-snapshot.json');
const DEFAULT_PRIORITY = 'P1 Next';
const DEFAULT_STATUS = 'Not started,In progress,Paused';
const DEFAULT_LIMIT = 500;
const GIT_TIMEOUT_MS = 120000;

const USAGE = `audit-card-relevance.js — classify open P1 cards as LIKELY-DONE / LIKELY-DUPLICATE / LIKELY-STALE / REAL.

Usage:
  node scripts/audit-card-relevance.js [--priority "P1 Next"] [--status "Not started,In progress,Paused"] [--limit N]
  node scripts/audit-card-relevance.js --skip-checkout

--skip-checkout   Skip the fresh-checkout acceptance-command / commit-ancestry
                  checks (no git fetch/worktree). Title-overlap, file+symbol
                  duplicate, and stale-file checks still run. Faster, useful
                  when offline or iterating.

Read-only — never touches Notion. Writes:
  ${path.relative(REPO, REPORT_PATH)}   (full per-card verdicts + evidence)
  ${path.relative(REPO, SNAPSHOT_PATH)} (digest-snapshot summary, consumed by
                                          scripts/lib/digest-snapshots.js)
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

// Best-effort per card, same posture as audit-card-verifiability.js: a
// single Notion blip must not sink the whole sweep.
function fetchCard(id) {
  try { return notionBrain(['get', id]); } catch (e) {
    console.error(`[audit-card-relevance] WARN fetch failed for ${id}: ${e.message.slice(0, 160)}`);
    return null;
  }
}

function fetchOpenP1Ids(priority, status, limit) {
  const table = notionBrain(['list', '--priority', priority, '--status', status, '--limit', String(limit)]);
  return table.map((row) => row.id);
}

// One shared, disposable, detached checkout of origin/main — the same
// pattern autonomous-acceptance-recheck.js uses, and for the same reason:
// N cards verifying against the same origin/main is one checkout, not N.
// Cached per cmd string, same pattern as makeIsCommitOnMain/
// makeGetCommitTouchedFiles: checkLikelyDone can call opts.runAcceptanceCmd
// with the SAME command up to 3x for one card (checkAcceptanceHolds, then
// checkCommitsOnMain's own-command gate, then checkRecheckAfterDueAndVerified
// all independently derive it via evaluateVerifiability) — without caching,
// a single slow/failing command re-executes (with its own 2-attempt retry
// and up to 5min timeout) up to 3 times per card across a sweep of hundreds
// (adversarial review catch, task #1724 follow-on).
function makeRunAcceptanceCmd(wt, prepared) {
  const cache = new Map();
  return (cmd) => {
    if (cache.has(cmd)) return cache.get(cmd);
    const result = runVerify(wt, cmd, { prepared });
    cache.set(cmd, result);
    return result;
  };
}

// Commit-ancestry checks read origin/main out of the LOCAL repo's refs —
// cheap, but only correct if those refs are current. makeFreshCheckout does
// its own `git fetch origin main` internally when a checkout is built, but
// the no-checkout path (no card names a runnable acceptance command) never
// fetches otherwise, so a commit that landed on main since this worktree was
// last synced would read as "not an ancestor" — a false negative (fails
// safe toward REAL, never a false LIKELY-DONE, but still worth fixing since
// it's one cheap call).
// unbounded-fetch-ok would be wrong here: depthArgs bounds it. Statically
// reachable from every shallow (fetch-depth: 1) CI checkout, so an unbounded
// `git fetch origin main` would ask upload-pack for the WHOLE ~2.1GB/165k-
// commit history instead of the delta (push-audit guard, task #466 class —
// same fix makeFreshCheckout in acceptance-check-core.js already applies).
function fetchOriginMain(repo) {
  const depthArgs = repoDepthArgs({ repoRoot: repo });
  try {
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    execFileSync('git', ['fetch', ...depthArgs, 'origin', 'main'], { cwd: repo, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`[audit-card-relevance] WARN git fetch origin main failed, commit-ancestry checks may use stale refs: ${e.message.slice(0, 160)}`);
  }
}

function makeIsCommitOnMain(repo) {
  const cache = new Map();
  return (sha) => {
    if (cache.has(sha)) return cache.get(sha);
    let result;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
        cwd: repo, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = true;
    } catch {
      // Covers both "not an ancestor" (exit 1) and "unknown object" (fatal) —
      // either way this classifier has no evidence the commit landed.
      result = false;
    }
    cache.set(sha, result);
    return result;
  };
}

// Files a commit touched, repo-relative — the "cited vs delivered" evidence
// checkCommitsOnMain needs (task #1724): a SHA only counts as this card's own
// delivery once it demonstrably touches a file the card's notes reference,
// not merely because it's cited as precedent/root-cause prose. Cached per
// sha like makeIsCommitOnMain, for the same reason (same shas get re-checked
// across cards that cite the same commit).
// -m is required: bare `diff-tree --name-only -r <sha>` returns EMPTY for a
// merge commit (verified live on 21c3b75627a, a real merge in this repo's
// log) — and this repo's own documented workflow (CLAUDE.md: `git merge
// <branch> --no-edit && git push`) lands most main-line work as a merge, so
// omitting -m would make gate 2 unsatisfiable for the common case (adversarial
// review catch, task #1724 follow-on).
function makeGetCommitTouchedFiles(repo) {
  const cache = new Map();
  return (sha) => {
    if (cache.has(sha)) return cache.get(sha);
    let result = [];
    try {
      const out = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', sha], {
        cwd: repo, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      });
      result = [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
    } catch (e) {
      console.error(`[audit-card-relevance] WARN git diff-tree failed for ${sha}: ${e.message.slice(0, 160)}`);
    }
    cache.set(sha, result);
    return result;
  };
}

// Test-file source, for checkAcceptanceHolds' DATA-SUBJECT weak-evidence
// check (task #1724) — a passing acceptance command whose test never imports
// the module under test can't confirm the underlying DATA actually changed.
function makeReadFile(repo) {
  return (relPath) => {
    try { return fs.readFileSync(path.join(repo, relPath), 'utf8'); } catch { return null; }
  };
}

// checkStaleFiles only cares whether the referenced LOCATION exists, not
// whether it's specifically a file — a card that says "the code lives in
// scripts/lib" names a real directory and must not read as stale just
// because isFile() is false for directories (ship-check finding, live
// reproduction: 'the code lives in scripts/lib and needs a helper' was
// misclassified LIKELY-STALE before this fix).
function makeFileExists(repo) {
  return (relPath) => {
    try { fs.statSync(path.join(repo, relPath)); return true; } catch { return false; }
  };
}

// A REAL card carrying a done-adjacent signal (BRO-343 live scan, 2026-08-16
// — see audit-card-relevance.js's detectDoneSignals header) is NOT evidence
// and NEVER changes its verdict; it only earns a spot near the front of the
// human-review queue below.
function hasDoneSignal(card) {
  return !!(card.signals && (card.signals.workspaceClosedNotDecided || card.signals.taskMirrorReportedCompleted));
}

function buildReport(evaluated, now) {
  const byVerdict = { 'LIKELY-DONE': [], 'LIKELY-DUPLICATE': [], 'LIKELY-STALE': [], REAL: [] };
  for (const c of evaluated) (byVerdict[c.verdict] || byVerdict.REAL).push(c);
  const realWithDoneSignal = byVerdict.REAL.filter(hasDoneSignal);
  return {
    generatedAt: now.toISOString(),
    total: evaluated.length,
    counts: {
      likelyDone: byVerdict['LIKELY-DONE'].length,
      likelyDuplicate: byVerdict['LIKELY-DUPLICATE'].length,
      likelyStale: byVerdict['LIKELY-STALE'].length,
      real: byVerdict.REAL.length,
      realWithDoneSignal: realWithDoneSignal.length,
    },
    cards: evaluated,
  };
}

function buildSnapshot(report, now) {
  const flagged = report.cards.filter((c) => c.verdict !== 'REAL');
  const realWithSignal = report.cards.filter((c) => c.verdict === 'REAL' && hasDoneSignal(c));
  const worthReview = [...flagged, ...realWithSignal];
  const bannerText = worthReview.length === 0
    ? `All ${report.total} open P1(s) checked out as REAL, no signals — nothing needs a second look`
    : `${flagged.length} of ${report.total} open P1(s) flagged (${report.counts.likelyDone} likely-done, ${report.counts.likelyDuplicate} likely-duplicate, ${report.counts.likelyStale} likely-stale)`
      + (realWithSignal.length ? `, plus ${realWithSignal.length} REAL card(s) carrying a done-adjacent signal worth a manual look` : '');
  const items = worthReview.slice(0, 10).map((c) => {
    const signalBits = c.verdict === 'REAL'
      ? [c.signals.workspaceClosedNotDecided && 'workspace-closed-not-decided', c.signals.taskMirrorReportedCompleted && 'task-mirror-reported-completed'].filter(Boolean).join(' + ')
      : null;
    return {
      title: c.verdict === 'REAL' ? `[REAL — signal] ${c.name}` : `[${c.verdict}] ${c.name}`,
      detail: `${signalBits || c.evidence?.type || 'no detail'}${c.url ? ` — ${c.url}` : ''}`,
      url: c.url || undefined,
    };
  });
  return {
    generatedAt: now.toISOString(),
    bannerText,
    items,
    moreCount: Math.max(0, worthReview.length - items.length),
  };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const priority = typeof args.priority === 'string' ? args.priority : DEFAULT_PRIORITY;
  const status = typeof args.status === 'string' ? args.status : DEFAULT_STATUS;
  const limit = args.limit ? parseInt(args.limit, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    process.exit(1);
  }
  const skipCheckout = !!args['skip-checkout'];

  const ids = fetchOpenP1Ids(priority, status, limit);
  console.error(`[audit-card-relevance] ${ids.length} card(s) fetched (priority=${priority}, status=${status})`);

  const cards = [];
  for (const [i, id] of ids.entries()) {
    const card = fetchCard(id);
    if (card) cards.push(card);
    if ((i + 1) % 25 === 0) console.error(`[audit-card-relevance] ${i + 1}/${ids.length} fetched`);
  }

  const needsCheckout = !skipCheckout && cards.some((c) => {
    const { cmd } = evaluateVerifiability(c.notes || '');
    return !!cmd;
  });

  let checkout = null;
  const opts = { now: new Date(), fileExists: makeFileExists(REPO) };
  if (needsCheckout) {
    console.error('[audit-card-relevance] at least one card names a runnable acceptance command — building a fresh origin/main checkout');
    try {
      checkout = makeFreshCheckout({ repo: REPO, prefix: 'card-relevance-check-' });
      opts.runAcceptanceCmd = makeRunAcceptanceCmd(checkout.wt, checkout.prepared);
      opts.isCommitOnMain = makeIsCommitOnMain(REPO);
      opts.getCommitTouchedFiles = makeGetCommitTouchedFiles(REPO);
      opts.readFile = makeReadFile(checkout.wt);
    } catch (e) {
      console.error(`[audit-card-relevance] WARN fresh checkout failed, skipping acceptance-command checks: ${e.message.slice(0, 200)}`);
      // Commit-ancestry checks don't need the checkout worktree at all — they
      // just run `git merge-base` against REPO directly — so a failed
      // checkout should still leave that check available (ship-check
      // finding: this used to silently drop commit-ancestry evidence too).
      if (!skipCheckout) {
        fetchOriginMain(REPO);
        opts.isCommitOnMain = makeIsCommitOnMain(REPO);
        opts.getCommitTouchedFiles = makeGetCommitTouchedFiles(REPO);
      }
    }
  } else if (!skipCheckout) {
    // No card needs a command execution, but commit-ancestry checks are
    // still cheap against the current repo — fetch origin/main directly
    // (no dedicated worktree checkout needed) so refs are current.
    fetchOriginMain(REPO);
    opts.isCommitOnMain = makeIsCommitOnMain(REPO);
    opts.getCommitTouchedFiles = makeGetCommitTouchedFiles(REPO);
  }

  let evaluated;
  try {
    evaluated = classifyPool(cards, opts);
  } finally {
    if (checkout) removeCheckout(checkout);
  }

  const now = new Date();
  const report = buildReport(evaluated, now);
  const snapshot = buildSnapshot(report, now);
  writeJson(REPORT_PATH, report);
  writeJson(SNAPSHOT_PATH, snapshot);

  console.log(`Total open P1(s) checked:  ${report.total}`);
  console.log(`LIKELY-DONE:               ${report.counts.likelyDone}`);
  console.log(`LIKELY-DUPLICATE:          ${report.counts.likelyDuplicate}`);
  console.log(`LIKELY-STALE:              ${report.counts.likelyStale}`);
  console.log(`REAL:                      ${report.counts.real}`);
  console.log(`  REAL w/ done-adjacent signal (never auto-closed, worth a manual look): ${report.counts.realWithDoneSignal}`);
  const flagged = evaluated.filter((c) => c.verdict !== 'REAL');
  if (flagged.length) {
    console.log('\nFlagged cards (first 20):');
    flagged.slice(0, 20).forEach((c) => console.log(`  [${c.verdict}] ${c.name} — ${c.evidence?.type} — ${c.url || c.id}`));
  }
  console.log(`\nReport written:  ${path.relative(REPO, REPORT_PATH)}`);
  console.log(`Snapshot written: ${path.relative(REPO, SNAPSHOT_PATH)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## P1 Card Relevance Audit',
      '',
      `| Verdict | Count |`,
      `|---------|-------|`,
      `| Total checked | ${report.total} |`,
      `| LIKELY-DONE | ${report.counts.likelyDone} |`,
      `| LIKELY-DUPLICATE | ${report.counts.likelyDuplicate} |`,
      `| LIKELY-STALE | ${report.counts.likelyStale} |`,
      `| REAL | ${report.counts.real} |`,
      '',
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs, notionBrain, fetchCard, fetchOpenP1Ids, buildReport, buildSnapshot, writeJson,
  makeIsCommitOnMain, makeFileExists, hasDoneSignal,
  REPORT_PATH, SNAPSHOT_PATH, DEFAULT_PRIORITY, DEFAULT_STATUS, DEFAULT_LIMIT, USAGE,
};
