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
 *   1. a linked commit sha (an ack-landed ledger row's `sha` for this
 *      taskId, or a sha the task text says the work landed/merged/shipped/
 *      was fixed in) that is an ancestor of origin/main;
 *   2. a linked PR (github.com/.../pull/N in the task text) whose merge or
 *      squash commit is on origin/main;
 *   3. a key file the task text names that exists on origin/main AND whose
 *      contents reference the task's OWN id (task #N / card #N, or its own
 *      BRO-N) on a line that does not mark it outstanding (TODO, known
 *      issue, ...).
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
// A sha only counts when the text says the task's work LANDED in it. Bare
// "commit <sha>" / "sha <sha>" is excluded: prose cites commits as causes
// ("regressed by commit abc1234") as often as fixes.
const TEXT_SHA_RE = /\b(?:landed|merged|shipped|fixed)(?:\s+(?:as|in|at|via|by))?(?:\s+(?:commit|sha))?[:\s]+`?([0-9a-f]{7,40})\b|\bfix(?:ed)?\s+commit[:\s]+`?([0-9a-f]{7,40})\b/gi;
// Cause-of-a-problem phrasing just before the sha disqualifies it.
// "not (yet) landed in", "partially fixed in", "never merged" say the work
// is NOT on main either (BRO-5261 retro-review). Applied to PR links too.
const SHA_NEGATIVE_CONTEXT_RE = /\b(?:regress\w*|broke\w*|break\w*|introduc\w*|caused|revert\w*|culprit|partial\w*|(?:not|never)\s+(?:yet\s+)?(?:landed|merged|shipped|fixed))\b/i;
// Ledger events that certify the task's work reached origin/main
// (ack-landed.js writes them after its own ancestry check). job-stranded's
// `sha` is the job worktree HEAD, often just the base commit, so it is NOT
// evidence and is ignored.
// One list, owned by dispatch-ledger.js (BRO-4662: hand copies drifted).
const { LANDED_ACK_EVENTS: LANDED_LEDGER_EVENTS, latestAttemptForTask } = require('./dispatch-ledger.js');
// This script's own auto-reopen notes (local REOPEN_MARKER line, Linear
// "Auto-corrected ... by reconcile-dead-completions" comment) are never
// evidence of anything.
const OWN_NOTE_LINE_RE = /^\[reconcile-dead-completions |^Auto-corrected .*reconcile-dead-completions/;
// A reference to the task on a line like this says the work is NOT done.
const NOT_DONE_LINE_RE = /\b(?:TODO|FIXME|XXX|not yet|known issue|unfixed|open)\b/i;
// Only this repo's PRs: an app-repo (BroadwayScorecard-app) PR #N would
// otherwise match this repo's unrelated "(#N)" squash commit.
const PR_URL_RE = /github\.com\/[\w.-]+\/Broadwayscore\/pull\/(\d+)(?!\d)/gi;
const KEY_FILE_RE = /(?:^|[\s(`'"[,])((?:scripts|src|tests|\.github|\.claude|supabase|data|docs|memory|public)\/[\w.@\-/]+\.[A-Za-z0-9]+)/g;
const OWN_LINEAR_MARKER_RE = /\[linear:(BRO-\d+)\]/g;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Refs that identify THIS task inside a file: its own id only. A numeric id
 * N yields "#N"; "linear:BRO-N" / "BRO-N" yield BRO-N; ownIds adds the
 * task's own Linear identifier (a task record's linearIdentifier field) and
 * notion-tasks-sync/linear-watchdog's "[linear:BRO-N]" marker counts too.
 * A BRO-N merely MENTIONED in the text ("follow-up to BRO-50") is never a
 * ref: a file naming BRO-50 says nothing about this task.
 */
function taskRefsOf(taskId, ownTexts = [], ownIds = []) {
  const refs = new Set();
  const add = (raw) => {
    const id = String(raw || '').trim();
    const linear = id.match(/^(?:linear:)?(BRO-\d+)$/);
    if (linear) refs.add(linear[1]);
    else if (/^\d+$/.test(id)) refs.add(`#${id}`);
  };
  add(taskId);
  for (const o of ownIds || []) add(o);
  for (const t of ownTexts) {
    for (const m of String(t || '').matchAll(OWN_LINEAR_MARKER_RE)) refs.add(m[1]);
  }
  return [...refs];
}

/** Drop this script's own auto-reopen notes from a task/issue text. */
function stripOwnNotes(text) {
  return String(text || '').split('\n').filter((l) => !OWN_NOTE_LINE_RE.test(l.trim())).join('\n');
}

/**
 * Does `content` mention any of `refs`? A numeric ref `#N` only matches
 * "task #N" / "card #N" / "task N": a bare "#N" in code is as often a PR or
 * issue number (squash subjects end "(#N)"), which would let an unrelated
 * file mark the task landed.
 */
//
// A reference on a TODO / FIXME / "not yet" / "known issue" / "unfixed" /
// "open" line does not count: it records the work as outstanding.
function contentReferencesTask(content, refs) {
  const res = (refs || []).map((ref) => (ref.startsWith('#')
    ? new RegExp(`\\b(?:task|card)\\s+#?${escapeRe(ref.slice(1))}(?!\\d)`, 'i')
    : new RegExp(`\\b${escapeRe(ref)}(?!\\d)`)));
  if (!res.length) return false;
  return String(content || '').split('\n').some((line) => (
    res.some((re) => re.test(line)) && !NOT_DONE_LINE_RE.test(line)
  ));
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
 * @returns {{refs: string[], shas: string[], dataRepoAcks: {repo: string, sha: string}[], prNumbers: number[], keyFiles: string[]}}
 */
function extractLandedEvidence({ taskId, texts = [], ownTexts = texts, entries = [], ownIds = [] } = {}) {
  const shas = new Set();
  const dataRepoAcks = [];
  const prNumbers = new Set();
  const keyFiles = new Set();
  const rows = Array.isArray(entries) ? entries : [];
  // A landing certified for an EARLIER dispatch round does not cover the
  // latest (dead) attempt: only ack rows for the latest attempt's jobId, or
  // written after it, count (landedAckOverridesDeath's scoping, BRO-4075;
  // BRO-5261 retro-review).
  const latest = latestAttemptForTask(taskId, rows);
  const latestTs = latest ? Date.parse(latest.ts || '') : NaN;
  for (const e of rows) {
    if (!e || String(e.taskId) !== String(taskId) || !LANDED_LEDGER_EVENTS.has(e.event)) continue;
    if (latest) {
      const ts = Date.parse(e.ts || '');
      const sameJob = latest.jobId && e.jobId === latest.jobId;
      const after = Number.isFinite(latestTs) && Number.isFinite(ts) && ts > latestTs;
      if (!sameJob && !after) continue;
    }
    if (typeof e.sha !== 'string' || !SHA_RE.test(e.sha)) continue;
    // ack-landed.js --data-repo (BRO-5219): the sha lives in a private data
    // repo and was verified there, so an is-ancestor probe of THIS repo would
    // always say no. The ack itself is the evidence.
    if (typeof e.repo === 'string' && e.repo) dataRepoAcks.push({ repo: e.repo, sha: e.sha.toLowerCase() });
    else shas.add(e.sha.toLowerCase());
  }
  const cleanTexts = (texts || []).map(stripOwnNotes);
  for (const t of cleanTexts) {
    for (const m of t.matchAll(TEXT_SHA_RE)) {
      const sha = m[1] || m[2];
      const before = t.slice(Math.max(0, m.index - 60), m.index + m[0].length);
      // All-digit tokens are almost always task/PR numbers, not shas.
      if (/[a-f]/i.test(sha) && !SHA_NEGATIVE_CONTEXT_RE.test(before)) shas.add(sha.toLowerCase());
    }
    for (const m of t.matchAll(PR_URL_RE)) {
      // "Regression introduced by <PR link>" names a cause, not this task's landing.
      if (!SHA_NEGATIVE_CONTEXT_RE.test(t.slice(Math.max(0, m.index - 60), m.index))) prNumbers.add(Number(m[1]));
    }
    for (const m of t.matchAll(KEY_FILE_RE)) {
      const p = m[1].replace(/[.,;:)\]'"`]+$/, '');
      if (isSafeRepoPath(p)) keyFiles.add(p);
    }
  }
  return {
    refs: taskRefsOf(taskId, (ownTexts || []).map(stripOwnNotes), ownIds),
    shas: [...shas],
    dataRepoAcks,
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
  const ack = (ev.dataRepoAcks || [])[0];
  if (ack) return { landed: true, reason: `acked in ${ack.repo} at ${ack.sha.slice(0, 12)}` };
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
        const r = exec(['log', ref, '-F', `--grep=(#${n})`, `--grep=Merge pull request #${n} from`, '--format=%H%x09%s', '-n', '20']);
        if (r.status !== 0) return null;
        // --grep also matches commit BODIES ("supersedes (#N)"): only a
        // SUBJECT naming the PR is its merge. A revert names it too: any
        // revert on main means the effect may be gone, so not landed
        // (conservative: the task stays reopenable).
        const own = new RegExp(`\\(#${n}\\)\\s*$|^Merge pull request #${n} from `);
        let landedSha = null;
        let revertDecided = false;
        for (const line of String(r.stdout || '').split('\n')) {
          const [sha, subject = ''] = line.split('\t');
          if (!SHA_RE.test(sha || '')) continue;
          const subj = subject.trim();
          // Newest first: the first revert-family subject decides. An even
          // number of 'Revert "' prefixes restores the work, an odd one removes it.
          if (!revertDecided && /^Revert\b/i.test(subj) && (subj.includes(`(#${n})`) || subj.includes(`#${n} `))) {
            const depth = (subj.match(/^(?:Revert ")+/i) || [''])[0].length / 'Revert "'.length;
            if (depth % 2 === 1) return null;
            revertDecided = true;
            continue;
          }
          if (/^Revert\b/i.test(subj)) continue;
          if (!landedSha && own.test(subj)) landedSha = sha;
        }
        return landedSha;
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
  stripOwnNotes,
  LANDED_LEDGER_EVENTS,
  makeGitProbe,
  DEFAULT_REF,
};
