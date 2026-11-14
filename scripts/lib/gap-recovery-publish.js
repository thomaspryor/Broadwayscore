'use strict';
/**
 * gap-recovery-publish.js — publish the gap-recovery ledgers (append-only
 * jsonl) to origin/main WITHOUT touching any working tree (BRO-7171 Stage 3).
 *
 * Why plumbing: the nightly job runs in the shared ~/Broadwayscore checkout,
 * where other launchd jobs and sessions fast-forward, reset regenerable
 * data/audit files, union-recover jsonl ledgers and push. Appending to (or
 * committing) the tracked ledger there races sync-audit-checkout.sh (a row can
 * be lost between its backup and reset) and leaves the checkout "ahead".
 * Second-opinion review 2026-11-09 (P1-1..3). So the run writes its rows to
 * ~/.broadwayscore-state/gap-recovery/*.jsonl, and this module builds ONE
 * commit on top of origin/main in a throwaway index:
 *   fetch -> merged = origin's lines + local lines origin lacks (origin order
 *   kept) -> hash-object, update-index on a temp GIT_INDEX_FILE read from
 *   origin/main -> write-tree -> commit-tree -p origin/main -> push sha:main.
 * A rejected push (origin moved) rebuilds on the new tip; the union is
 * idempotent, so a retry or a rerun never doubles or drops a row. The push is
 * data-only, which scripts/hooks/pre-push allows (direct-push-guard.sh).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Pure: origin's lines, then local lines origin does not already have (exact line match). */
function unionLines(originText, localText) {
  const split = (t) => String(t || '').split('\n').filter((l) => l.trim());
  const origin = split(originText);
  const seen = new Set(origin);
  const added = [];
  // Local side: a torn trailing line (no final newline, mid-append) and any
  // line that is not JSON never reach origin.
  let local = String(localText || '');
  if (local && !local.endsWith('\n')) local = local.slice(0, local.lastIndexOf('\n') + 1);
  const isJson = (l) => { try { JSON.parse(l); return true; } catch { return false; } };
  for (const l of split(local)) if (!seen.has(l) && isJson(l)) { seen.add(l); added.push(l); }
  const lines = origin.concat(added);
  return { text: lines.length ? lines.join('\n') + '\n' : '', added: added.length, base: origin.length };
}

function gitRunner(repoDir, extraEnv = {}) {
  return (args, opts = {}) => execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, ...(opts.env || {}) },
    input: opts.input,
    timeout: opts.timeout || 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * @param {object} a
 * @param {string} a.repoDir any checkout/worktree of the public repo (its object DB is used, never its working tree)
 * @param {Array<{rel:string, localPath:string}>} a.files repo-relative ledger path + local state file
 * @param {string} a.message commit message
 * @param {string} [a.remote='origin'] @param {string} [a.branch='main']
 * @param {number} [a.attempts=5]
 * @returns {{pushed:boolean, commit?:string, added:Record<string,number>, attempts:number, upToDate?:boolean}}
 */
function publishLedgers({ repoDir, files, message, remote = 'origin', branch = 'main', attempts = 5, log = () => {} }) {
  let added = {};
  const r = publishComputed({
    repoDir, message, remote, branch, attempts, log, label: 'gap-recovery ledgers',
    compute: (originText) => {
      const changes = [];
      added = {};
      for (const f of files) {
        let localText = '';
        try { localText = fs.readFileSync(f.localPath, 'utf8'); } catch { /* none yet */ }
        const u = unionLines(originText(f.rel), localText);
        added[f.rel] = u.added;
        if (u.added) changes.push({ rel: f.rel, text: u.text });
      }
      return changes;
    },
  });
  if (r.pushed) log(`published ${Object.entries(added).filter(([, n]) => n).map(([rel, n]) => `${rel} +${n}`).join(', ')} as ${r.commit.slice(0, 10)}`);
  return { ...r, added };
}

/**
 * The plumbing loop shared by every "publish a data file to origin/main
 * without a working tree" caller: fetch to a private ref, compute the new file
 * texts from origin's, commit in a throwaway index, push; a rejected push
 * recomputes on the new tip. compute must be idempotent.
 * @param {object} a
 * @param {(originText:(rel:string)=>string) => Array<{rel:string,text:string}>} a.compute
 * @param {(commit:string) => void} [a.beforePush] journal hook: runs after the commit exists, before the push
 * @returns {{pushed:boolean, commit?:string, attempts:number, upToDate?:boolean}}
 */
function publishComputed({ repoDir, message, compute, beforePush, remote = 'origin', branch = 'main', attempts = 5, log = () => {}, label = 'data files' }) {
  // A bot push (direct-push-guard.sh allow:push-with-retry-bot); a pre-push
  // refusal still fails the push and is retried, never counted as published.
  const git = gitRunner(repoDir, { PUSH_WITH_RETRY_CALLER: 'bot' });
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      // A private ref, never FETCH_HEAD: other jobs in the shared checkout
      // fetch other branches and would swap the base under us.
      const privRef = `refs/gap-publish/${branch}`;
      git(['fetch', '--quiet', remote, `+refs/heads/${branch}:${privRef}`], { timeout: 180000 });
      const base = git(['rev-parse', privRef]).trim();
      const originText = (rel) => { try { return git(['show', `${base}:${rel}`]); } catch { return ''; } };
      const changes = compute(originText).filter((c) => c.text !== originText(c.rel));
      if (!changes.length) return { pushed: false, upToDate: true, attempts: i };
      const idx = path.join(os.tmpdir(), `gap-publish-index-${process.pid}-${Date.now()}`);
      const env = { GIT_INDEX_FILE: idx };
      try {
        git(['read-tree', base], { env });
        for (const c of changes) {
          const blob = git(['hash-object', '-w', '--stdin'], { input: c.text }).trim();
          git(['update-index', '--add', '--cacheinfo', `100644,${blob},${c.rel}`], { env });
        }
        const tree = git(['write-tree'], { env }).trim();
        const commit = git(['commit-tree', tree, '-p', base, '-m', message]).trim();
        if (beforePush) beforePush(commit);
        git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`], { timeout: 180000 });
        return { pushed: true, commit, attempts: i };
      } finally {
        try { fs.unlinkSync(idx); } catch { /* none */ }
      }
    } catch (e) {
      lastErr = e;
      log(`publish attempt ${i} failed: ${String((e.stderr || e.message || '')).split('\n').filter(Boolean).slice(-1)[0] || e.message}`);
      if (i < attempts) sleep(Math.min(30000, 2000 * 2 ** (i - 1)) + Math.floor(Math.random() * 1000));
    }
  }
  const err = new Error(`${label} not published after ${attempts} attempts: ${lastErr && lastErr.message}`);
  err.cause = lastErr;
  throw err;
}

/** Is `commit` on origin's branch (fetched into the private ref)? */
function landedOnOrigin({ repoDir, commit, remote = 'origin', branch = 'main' }) {
  const git = gitRunner(repoDir);
  const privRef = `refs/gap-publish/${branch}`;
  git(['fetch', '--quiet', remote, `+refs/heads/${branch}:${privRef}`], { timeout: 180000 });
  try { git(['merge-base', '--is-ancestor', commit, privRef]); return true; } catch { return false; }
}

/**
 * Local state file = union of origin's tracked copy, the shared checkout's
 * working copy (a manual driver run appends there) and what the state file
 * already holds. Run before the nightly so eligibility sees every attempt.
 */
function seedStateFile({ repoDir, rel, localPath, remote = 'origin', branch = 'main' }) {
  const git = gitRunner(repoDir);
  let originText = '';
  try { originText = git(['show', `${remote}/${branch}:${rel}`]); } catch { /* not there */ }
  let workText = '';
  try { workText = fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch { /* none */ }
  let stateText = '';
  try { stateText = fs.readFileSync(localPath, 'utf8'); } catch { /* none */ }
  // Drop torn/non-JSON lines on the state side too: a torn tail left there
  // would be joined to the next appended row and lose both.
  const cleanState = unionLines('', stateText).text;
  const merged = unionLines(unionLines(cleanState, originText).text, workText);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const tmp = `${localPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, merged.text);
  fs.renameSync(tmp, localPath);
  return merged.text ? merged.text.split('\n').filter(Boolean).length : 0;
}

module.exports = { unionLines, publishLedgers, publishComputed, landedOnOrigin, seedStateFile };
