'use strict';

/**
 * dead-completion-landed-check.js — direct-effect verification for
 * reconcile-dead-completions.js (BRO-2313).
 *
 * reconcile-dead-completions.js used to propose reopening a completed task
 * purely because its latest dispatch-ledger attempt was journaled dead. A
 * dead ledger row says the JOB died, not that the WORK is missing, and the
 * pass produced false positives where the work had landed anyway:
 *   - task #1834: scripts/lib/reconcile-merged-json.js exists on origin/main
 *     and names BRO-76 (the card the task tracked);
 *   - tasks #1896/#1898: scripts/linear-next.js exists on origin/main and
 *     names both tasks (its linear-dispatch-claims block).
 *
 * This module checks the task's direct effect on origin/main before any
 * reopen is proposed. Evidence that counts (any one is enough):
 *   1. a linked commit sha (a ledger row's `sha` for this taskId, or a sha
 *      the task text introduces with "commit"/"sha"/"landed"/"merged") that
 *      is an ancestor of origin/main;
 *   2. a linked PR (github.com/.../pull/N in the task text) whose merge or
 *      squash commit is on origin/main;
 *   3. a key file the task text names that exists on origin/main AND whose
 *      contents reference the task (#N / task #N / card #N, or a BRO-N
 *      identifier the task carries).
 *
 * Conservative by design: missing or unreadable evidence => NOT landed, so
 * the task stays reopenable. A key file that exists but never mentions the
 * task does not count (a common file like scripts/linear-next.js exists for
 * reasons unrelated to any one task). origin/main is read as-is, never
 * fetched: a stale ref can only hide a landing, which keeps the task
 * reopenable (the pre-BRO-2313 behavior), never the reverse.
 *
 * extractLandedEvidence and decideWorkLanded are PURE. makeGitProbe wraps
 * git behind an injectable `run` so tests never need a network.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REF = 'origin/main';
const REPO_ROOT = path.join(__dirname, '..', '..');

const SHA_RE = /^[0-9a-f]{7,40}$/i;
// A sha only counts when the text introduces it as one; a bare hex token in
// prose is too easily something else (a hash, a color, an unrelated commit
// cited as the cause of a regression).
const TEXT_SHA_RE = /\b(?:commit|sha|landed(?:\s+(?:as|in|at))?|merged(?:\s+(?:as|in|at))?)[:\s]+`?([0-9a-f]{7,40})\b/gi;
// Only this repo's PRs: an app-repo (BroadwayScorecard-app) PR #N would
// otherwise match this repo's unrelated "(#N)" squash commit.
const PR_URL_RE = /github\.com\/[\w.-]+\/Broadwayscore\/pull\/(\d+)(?!\d)/gi;
const KEY_FILE_RE = /(?:^|[\s(`'"[,])((?:scripts|src|tests|\.github|\.claude|supabase|data|docs|memory|public)\/[\w.@\-/]+\.[A-Za-z0-9]+)/g;
const LINEAR_ID_RE = /\bBRO-\d+(?!\d)/g;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Refs that identify a task inside a file: numeric task id and/or BRO-N ids. */
function taskRefsOf(taskId, texts = []) {
  const refs = new Set();
  const id = String(taskId || '');
  const linear = id.match(/^linear:(BRO-\d+)$/);
  if (linear) refs.add(linear[1]);
  else if (/^\d+$/.test(id)) refs.add(`#${id}`);
  else if (/^BRO-\d+$/.test(id)) refs.add(id);
  for (const t of texts) {
    for (const m of String(t || '').matchAll(LINEAR_ID_RE)) refs.add(m[0]);
  }
  return [...refs];
}

/**
 * Does `content` mention any of `refs`? A numeric ref `#N` only matches
 * "task #N" / "card #N" / "task N": a bare "#N" in code is as often a PR or
 * issue number (squash subjects end "(#N)"), which would let an unrelated
 * file mark the task landed.
 */
function contentReferencesTask(content, refs) {
  const text = String(content || '');
  return (refs || []).some((ref) => {
    if (ref.startsWith('#')) {
      const n = escapeRe(ref.slice(1));
      return new RegExp(`\\b(?:task|card)\\s+#?${n}(?!\\d)`, 'i').test(text);
    }
    return new RegExp(`\\b${escapeRe(ref)}(?!\\d)`).test(text);
  });
}

function isSafeRepoPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('-') && !p.startsWith('/')
    && !p.split('/').includes('..');
}

/**
 * PURE. Collect linkable evidence for one task.
 * @param {{taskId: string, texts?: string[], entries?: object[]}} input
 *   texts: the task's own prose (subject, description, or a Linear issue's
 *   description + comment bodies); entries: dispatch-ledger rows (only rows
 *   for this taskId are read, for their `sha`).
 * @returns {{refs: string[], shas: string[], prNumbers: number[], keyFiles: string[]}}
 */
function extractLandedEvidence({ taskId, texts = [], entries = [] } = {}) {
  const shas = new Set();
  const prNumbers = new Set();
  const keyFiles = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || String(e.taskId) !== String(taskId)) continue;
    if (typeof e.sha === 'string' && SHA_RE.test(e.sha)) shas.add(e.sha.toLowerCase());
  }
  for (const raw of texts) {
    const t = String(raw || '');
    for (const m of t.matchAll(TEXT_SHA_RE)) {
      // All-digit tokens are almost always task/PR numbers, not shas.
      if (/[a-f]/i.test(m[1])) shas.add(m[1].toLowerCase());
    }
    for (const m of t.matchAll(PR_URL_RE)) prNumbers.add(Number(m[1]));
    for (const m of t.matchAll(KEY_FILE_RE)) {
      const p = m[1].replace(/[.,;:)\]'"`]+$/, '');
      if (isSafeRepoPath(p)) keyFiles.add(p);
    }
  }
  return {
    refs: taskRefsOf(taskId, texts),
    shas: [...shas],
    prNumbers: [...prNumbers],
    keyFiles: [...keyFiles],
  };
}

/**
 * PURE given `git`. Decide whether the task's work is on origin/main.
 * @param {{refs: string[], shas: string[], prNumbers: number[], keyFiles: string[]}} evidence
 * @param {{isAncestor: (sha: string) => boolean, prMerged: (n: number) => (string|null), readFile: (p: string) => (string|null)}} git
 * @returns {{landed: boolean, reason: string}}
 */
function decideWorkLanded(evidence, git) {
  const ev = evidence || {};
  if (!git) return { landed: false, reason: 'no git probe' };
  for (const sha of ev.shas || []) {
    if (safeCall(() => git.isAncestor(sha))) return { landed: true, reason: `commit ${sha.slice(0, 12)} is an ancestor of ${DEFAULT_REF}` };
  }
  for (const n of ev.prNumbers || []) {
    const sha = safeCall(() => git.prMerged(n));
    if (sha) return { landed: true, reason: `PR #${n} merged as ${String(sha).slice(0, 12)} on ${DEFAULT_REF}` };
  }
  const refs = ev.refs || [];
  if (refs.length) {
    for (const p of ev.keyFiles || []) {
      const content = safeCall(() => git.readFile(p));
      if (typeof content === 'string' && contentReferencesTask(content, refs)) {
        return { landed: true, reason: `${p} exists on ${DEFAULT_REF} and references ${refs.join('/')}` };
      }
    }
  }
  return { landed: false, reason: 'no landed evidence on ' + DEFAULT_REF };
}

function safeCall(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * Git-backed probe for decideWorkLanded. `run(args)` returns
 * {status, stdout}; the default shells out to git in the repo root. Never
 * fetches. Results are memoized per probe (one CLI run builds one probe).
 */
function makeGitProbe({ ref = DEFAULT_REF, cwd = REPO_ROOT, run } = {}) {
  const exec = run || ((args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    return { status: r.status, stdout: r.stdout || '' };
  });
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return {
    isAncestor(sha) {
      if (!SHA_RE.test(String(sha || ''))) return false;
      return memo(`a:${sha}`, () => {
        if (exec(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) return false;
        return exec(['merge-base', '--is-ancestor', sha, ref]).status === 0;
      });
    },
    prMerged(n) {
      if (!Number.isInteger(n) || n <= 0) return null;
      return memo(`p:${n}`, () => {
        const r = exec(['log', ref, '-F', `--grep=(#${n})`, `--grep=Merge pull request #${n} from`, '--format=%H', '-n', '1']);
        const sha = r.status === 0 ? String(r.stdout || '').trim() : '';
        return SHA_RE.test(sha) ? sha : null;
      });
    },
    readFile(p) {
      if (!isSafeRepoPath(p)) return null;
      return memo(`f:${p}`, () => {
        const r = exec(['cat-file', '-p', `${ref}:${p}`]);
        return r.status === 0 ? String(r.stdout || '') : null;
      });
    },
  };
}

/** Convenience: extract + decide in one call. */
function checkWorkLanded(input, git) {
  return decideWorkLanded(extractLandedEvidence(input), git);
}

module.exports = {
  extractLandedEvidence,
  decideWorkLanded,
  checkWorkLanded,
  contentReferencesTask,
  taskRefsOf,
  makeGitProbe,
  DEFAULT_REF,
};
