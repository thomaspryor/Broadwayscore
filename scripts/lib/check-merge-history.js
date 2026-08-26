/**
 * check-merge-history.js — history-depth safety net for the oscillation
 * breaker in scripts/autonomous-merge.js (countPriorMerges).
 *
 * BRO-423: autonomous-merge.yml's checkout used `fetch-depth: 0` so that
 * `git log --grep <Auto-merge-card trailer> origin/main` could see the
 * ENTIRE commit graph — countPriorMerges must never undercount (the owner
 * spec is "2+ prior merges is a hard stop, never auto-revert"; missing an
 * earlier merge because of a shallow clone would silently defeat that
 * guard). But `fetch-depth: 0` was also transferring every historical blob
 * of this repo's large data/*.json files across thousands of commits — ~35
 * of the job's 50-minute budget was spent on that single checkout step.
 *
 * The fix is a blobless partial clone (`filter: blob:none` in the workflow):
 * the full commit graph still downloads (fast — commits/trees only), so
 * `git log --grep` — which never touches blob content — is unaffected, and
 * costly blob transfer is deferred to on-demand fetches for whatever the
 * rebase actually needs. This module is the safety net for that contract:
 * if a future workflow edit shrinks fetch-depth (accidentally reintroducing
 * a shallow clone), ensureFullHistory() detects it and deepens in place
 * BEFORE the oscillation scan runs, instead of silently returning a low
 * count.
 */

'use strict';

const { execFileSync } = require('child_process');

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** True if `cwd`'s clone is shallow (a `.git/shallow` boundary exists). */
function isShallowClone(cwd, gitFn = runGit) {
  try {
    return gitFn(['rev-parse', '--is-shallow-repository'], cwd).trim() === 'true';
  } catch {
    // Not a git repo, or the command otherwise failed — treat as "can't
    // prove it's full", which is the safe (deepen-attempting) direction.
    return true;
  }
}

/**
 * Deepens `cwd` to full history when it's shallow. No-ops on the
 * full-history-but-blobless clone the workflow normally produces (a blob
 * filter does not set the shallow boundary). Returns whether a fetch ran,
 * for logging/testing. Never throws itself — a failed deepen is reported
 * back via `error` so countPriorMergesInHistory() can decide whether the
 * clone is STILL shallow afterward (see below) rather than silently
 * counting on a possibly-incomplete history.
 */
function ensureFullHistory(cwd, { gitFn = runGit, log = () => {} } = {}) {
  if (!isShallowClone(cwd, gitFn)) return { deepened: false };
  log('[check-merge-history] shallow clone detected — deepening to full history before oscillation scan');
  try {
    gitFn(['fetch', '--unshallow', 'origin'], cwd);
    return { deepened: true };
  } catch (err) {
    log(`[check-merge-history] WARN could not deepen shallow clone: ${String(err.message || err).slice(0, 200)}`);
    return { deepened: false, error: err };
  }
}

/**
 * Counts commits reachable from `ref` whose message contains `trailer`
 * (fixed-string match — trailers are never regexes). Ensures full history
 * first via ensureFullHistory().
 *
 * FAILS CLOSED (throws) rather than returning a possibly-wrong count,
 * because this value gates the oscillation breaker's "2+ prior merges is a
 * hard stop, never auto-revert" — an undercounted 0 or 1 here would let a
 * broken card merge a 3rd time with no signal to the owner (adversarial
 * review, BRO-423: the original best-effort "swallow to 0" version of this
 * function was flagged as silently unsafe on exactly this path). Two throw
 * cases: (a) the clone is STILL shallow after ensureFullHistory's deepen
 * attempt — partial history must never be counted as if it were complete;
 * (b) the `git log --grep` scan itself fails (corrupt ref, missing object,
 * etc.) — that also means the count can't be trusted. Both surface as a CI
 * job failure (autonomous-merge.js's main().catch → non-zero exit → the
 * workflow's Notify-on-failure step), which is the safe direction: no
 * merge happens, and the owner is alerted instead of an undercounted
 * approval sailing through silently.
 */
function countPriorMergesInHistory(trailer, ref, cwd, { gitFn = runGit, log = () => {} } = {}) {
  ensureFullHistory(cwd, { gitFn, log });
  if (isShallowClone(cwd, gitFn)) {
    throw new Error(
      'oscillation scan aborted: clone is shallow and could not be deepened to full history — ' +
      'refusing to count prior merges on partial history (would risk silently undercounting the ' +
      '"2+ prior merges" hard stop). Check the checkout step (fetch-depth: 0) and network access to origin.'
    );
  }
  let out;
  try {
    out = gitFn(['log', '--fixed-strings', '--grep', trailer, '--format=%H', ref], cwd);
  } catch (err) {
    throw new Error(`oscillation scan aborted: git log --grep against ${ref} failed: ${String(err.message || err).slice(0, 300)}`);
  }
  return String(out || '').trim().split('\n').filter(Boolean).length;
}

module.exports = { isShallowClone, ensureFullHistory, countPriorMergesInHistory };
