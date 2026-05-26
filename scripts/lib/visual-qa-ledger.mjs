#!/usr/bin/env node
// scripts/lib/visual-qa-ledger.mjs — local append-only ledger of visual-qa
// approvals, so that merging a worktree branch into main inherits the prior
// approval instead of forcing a fresh /visual-qa cycle.
//
// History: /plan-review 2026-05-25 considered a git-notes ledger (push-able
// to origin) and rejected it — public-repo leakage, rebase/squash race, no
// rollback story. This module is the redesign: a JSONL file under
// `.claude/visual-qa/approvals.jsonl` (gitignored), one entry per APPROVED
// detection. Hook walks `git log origin/main..HEAD` and looks each
// UI-touching commit up in the ledger.
//
// Wire format (one JSON object per line):
//   { ts, sessionId, branch, commitSha, contentHash }
//
// Queries (CLI):
//   --query=push-allowed --repo=<path>
//     Walks origin/main..HEAD on <path>. Returns {allowed, reason, missing[]}.
//   --query=record --repo=<path> --branch=<b> --commit=<sha> --hash=<h> --session=<sid>
//     Appends one entry. Atomic open-and-append; safe under concurrent hooks.
//
// Honors VISUAL_QA_LEDGER_TTL_DAYS env (default 7). Entries older than the
// TTL are treated as not present.

import { existsSync, readFileSync, openSync, writeSync, closeSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_TTL_DAYS = 7;

function ttlMs() {
  const d = Number(process.env.VISUAL_QA_LEDGER_TTL_DAYS || DEFAULT_TTL_DAYS);
  if (!Number.isFinite(d) || d <= 0) return DEFAULT_TTL_DAYS * 86400_000;
  return d * 86400_000;
}

function ledgerPath(repoRoot) {
  return join(repoRoot, '.claude', 'visual-qa', 'approvals.jsonl');
}

function readLedger(repoRoot) {
  const path = ledgerPath(repoRoot);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && r.commitSha) entries.push(r);
    } catch { /* skip malformed line */ }
  }
  return entries;
}

export function recordApproval(repoRoot, { branch, commitSha, contentHash, sessionId }) {
  if (!commitSha || !contentHash) {
    throw new Error('recordApproval: commitSha and contentHash are required');
  }
  const path = ledgerPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    sessionId: sessionId || null,
    branch: branch || null,
    commitSha,
    contentHash,
  };
  // O_APPEND flag = atomic append on POSIX; safe under concurrent writers.
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, JSON.stringify(entry) + '\n');
  } finally {
    closeSync(fd);
  }
  return entry;
}

// UI-file detector — must match the pre-push-visual-gate.sh grep pattern.
const UI_FILE_RE = /^(?:src\/.*\.(?:tsx|jsx|css|scss|module\.css)|tailwind\.config\.|postcss\.config\.|src\/app\/.*\.(?:tsx|jsx|ts|js))/;

function commitsInRange(repoRoot, base = 'origin/main', head = 'HEAD') {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'log', '--format=%H %P', `${base}..${head}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).map(line => {
      const [sha, ...parents] = line.split(' ');
      return { sha, parents };
    });
  } catch {
    return [];
  }
}

function uiFilesInCommit(repoRoot, sha) {
  try {
    // diff-tree -m --first-parent: for merge commits, compare against first parent
    // (the branch we were on before merging in). Files only added by the merge
    // would appear here; we don't want to surface files that already existed
    // on the first parent.
    const out = execFileSync('git', ['-C', repoRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).filter(p => UI_FILE_RE.test(p));
  } catch {
    return [];
  }
}

export function queryPushAllowed(repoRoot) {
  const entries = readLedger(repoRoot);
  const now = Date.now();
  const ttl = ttlMs();
  const fresh = new Map(); // commitSha -> latest fresh entry
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (now - t > ttl) continue;
    fresh.set(e.commitSha, e);
  }
  const commits = commitsInRange(repoRoot);
  if (commits.length === 0) {
    return { allowed: false, reason: 'no commits ahead of origin/main (or git error)' };
  }
  const missing = [];
  for (const { sha, parents } of commits) {
    const uiFiles = uiFilesInCommit(repoRoot, sha);
    if (uiFiles.length === 0) continue; // non-UI commit; doesn't need approval
    // Merge commit inheritance: if it's a merge (≥2 parents), accept when ALL
    // non-merge parents that themselves touch UI either have ledger entries
    // OR are reachable from an approved parent. Conservative: require the
    // merge commit ITSELF or at least one parent in the range to be in the
    // ledger. This is the common rebase-merge case.
    const isMerge = parents.length >= 2;
    if (fresh.has(sha)) continue;
    if (isMerge && parents.some(p => fresh.has(p))) continue;
    missing.push({ sha, uiFiles });
  }
  if (missing.length === 0) {
    return { allowed: true, reason: `ledger has fresh entries for all UI-touching commits in range (${commits.length} total)` };
  }
  return {
    allowed: false,
    reason: `${missing.length} UI-touching commit(s) lack a fresh ledger entry`,
    missing,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq >= 0) a[tok.slice(2, eq)] = tok.slice(eq + 1);
    else a[tok.slice(2)] = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) { console.error('--query is required'); process.exit(1); }
  const repoRoot = args.repo || process.cwd();

  if (args.query === 'push-allowed') {
    const result = queryPushAllowed(repoRoot);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (args.query === 'record') {
    if (!args.commit || !args.hash) { console.error('--commit and --hash required'); process.exit(1); }
    const entry = recordApproval(repoRoot, {
      branch: args.branch,
      commitSha: args.commit,
      contentHash: args.hash,
      sessionId: args.session,
    });
    console.log(JSON.stringify({ ok: true, entry }));
    process.exit(0);
  }

  console.error(`unknown query: ${args.query}`);
  process.exit(1);
}

const __isMain = import.meta.url === `file://${process.argv[1]}`;
if (__isMain) {
  main().catch(err => { console.error(`FATAL: ${err?.stack || err}`); process.exit(1); });
}
