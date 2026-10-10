#!/usr/bin/env node
// scripts/lib/visual-qa-ledger.mjs — local append-only ledger of visual-qa
// approvals, so that merging a worktree branch into main inherits the prior
// approval instead of forcing a fresh /visual-qa cycle.
//
// History:
//   2026-05-25 /plan-review considered a git-notes ledger (push-able to
//     origin) and rejected it — public-repo leakage, rebase/squash race,
//     no rollback story.
//   2026-05-26 /ship-check P0-2/P0-4 found the SHA-only lookup breaks under
//     rebase + squash-merge: every commit gets a fresh SHA, so even though
//     the visual content is identical (and the user already APPROVED that
//     content), the ledger reports "missing entries." Fix: index entries by
//     BOTH commitSha AND contentHash. A current verdict.json's contentHash
//     matching any fresh ledger entry's contentHash is sufficient to allow
//     the push — pixels are what we're actually gating on.
//
// Wire format (one JSON object per line):
//   { ts, sessionId, branch, commitSha, contentHash }
//
// Queries (CLI):
//   --query=push-allowed --repo=<path> [--current-content-hash=<hash>]
//     Walks origin/HEAD..HEAD on <path>. Returns {allowed, reason, missing[]}.
//     If --current-content-hash is provided, a fresh ledger entry with that
//     contentHash allows the push regardless of commit SHA matches.
//   --query=record --repo=<path> --branch=<b> --commit=<sha> --hash=<h> --session=<sid>
//     Appends one entry. Atomic open-and-append; safe under concurrent hooks.
//
// Honors VISUAL_QA_LEDGER_TTL_DAYS env (default 7). Entries older than the
// TTL are treated as not present.

import { existsSync, readFileSync, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { UI_PATH_RE } from './ui-paths.mjs';

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
    } catch { /* skip malformed line — partial-write race tolerated */ }
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
  // O_APPEND = atomic append for writes <= PIPE_BUF (512 bytes on macOS).
  // Entries are ~120 bytes; concurrent writers don't interleave.
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, JSON.stringify(entry) + '\n');
  } finally {
    closeSync(fd);
  }
  return entry;
}

// P1c (Codex): resolve the default branch dynamically. `origin/HEAD` is set
// by `git clone` to track the remote's default; if missing (older clones,
// some CI setups), fall back to origin/main.
export function defaultBranchRef(repoRoot) {
  try {
    const out = execFileSync(
      'git', ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return 'origin/main';
}

function commitsInRange(repoRoot, base, head = 'HEAD') {
  const baseRef = base || defaultBranchRef(repoRoot);
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'log', '--format=%H %P', `${baseRef}..${head}`], {
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
    const out = execFileSync('git', ['-C', repoRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).filter(p => UI_PATH_RE.test(p));
  } catch {
    return [];
  }
}

export function queryPushAllowed(repoRoot, { currentContentHash } = {}) {
  const entries = readLedger(repoRoot);
  const now = Date.now();
  const ttl = ttlMs();
  // Index fresh entries by BOTH dimensions so rebase/squash (SHA changes)
  // and amend (SHA replaced) still inherit approval when content is the same.
  const freshBySha = new Map();
  const freshByHash = new Map();
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (now - t > ttl) continue;
    freshBySha.set(e.commitSha, e);
    if (e.contentHash) freshByHash.set(e.contentHash, e);
  }

  // P0c: if a current verdict.json's contentHash matches ANY fresh ledger
  // entry, the push is allowed regardless of commit SHA topology. The
  // contentHash is what the user actually approved.
  if (currentContentHash && freshByHash.has(currentContentHash)) {
    return {
      allowed: true,
      reason: `contentHash ${currentContentHash} matches fresh ledger entry (rebase/squash-tolerant)`,
    };
  }

  const baseRef = defaultBranchRef(repoRoot);
  const commits = commitsInRange(repoRoot, baseRef);
  if (commits.length === 0) {
    return { allowed: false, reason: `no commits ahead of ${baseRef} (or git error)` };
  }
  const missing = [];
  for (const { sha, parents } of commits) {
    const uiFiles = uiFilesInCommit(repoRoot, sha);
    if (uiFiles.length === 0) continue;
    const isMerge = parents.length >= 2;
    if (freshBySha.has(sha)) continue;
    if (isMerge && parents.some(p => freshBySha.has(p))) continue;
    missing.push({ sha, uiFiles });
  }
  if (missing.length === 0) {
    return { allowed: true, reason: `ledger has fresh entries for all UI-touching commits in range (${commits.length} total, base=${baseRef})` };
  }
  return {
    allowed: false,
    reason: `${missing.length} UI-touching commit(s) lack a fresh ledger entry (base=${baseRef})`,
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
    const result = queryPushAllowed(repoRoot, {
      currentContentHash: args['current-content-hash'] || null,
    });
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
