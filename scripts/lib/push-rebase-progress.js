#!/usr/bin/env node
'use strict';
// Pure decision function for push-with-retry.sh's post-rebase progress assertion
// (task #394). Extracted per CLAUDE.md §15 so the shell helper and its test share
// ONE source of truth instead of copying the logic into a test.
//
// The bug it guards against: under actions/checkout's SHA-pinned fetch refspec, a
// bare `git fetch origin main` updates FETCH_HEAD but NOT refs/remotes/origin/main,
// so `git rebase -X theirs origin/main` targets the STALE tracking ref, reports
// "Current branch main is up to date", and integrates nothing. The retry loop then
// re-pushes the same stale HEAD, gets rejected ("fetch first") for all 7 attempts,
// and the `|| echo ::warning` at the call site swallows it — so the alert-ledger (or
// any state file) NEVER persists from CI and every cooldown/dedup guarantee is void.
//
// After a push is rejected (remote strictly ahead) and the helper fetches + runs a
// resolution that REPORTS success (historyChanged=true), our HEAD must now contain
// the fetched remote tip. If it does not, the resolution was a silent no-op: the
// push can never fast-forward and retrying is pointless. That is the abort signal.
//
// When historyChanged is false the resolution genuinely failed (or there was nothing
// to integrate) — that keeps the existing backoff/retry/exhaustion path, NOT the
// loud abort, so genuine transient conflicts are unaffected.

/**
 * @param {{remoteInHistory: boolean, historyChanged: boolean}} state
 * @returns {boolean} true when the rebase/merge claimed success but left the
 *   fetched remote tip out of HEAD's history — the #394 silent no-op.
 */
function isNoopRebase({ remoteInHistory, historyChanged }) {
  return historyChanged === true && remoteInHistory === false;
}

module.exports = { isNoopRebase };

// ── CLI: called by push-with-retry.sh so bash and the test share this logic ──
// Usage: node push-rebase-progress.js --remote-in-history=<true|false> --history-changed=<true|false>
// Prints "NOOP" and exits 3 when it's a no-op; prints "OK" and exits 0 otherwise.
if (require.main === module) {
  const parseBool = (name) => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (!arg) return undefined;
    const v = arg.slice(arg.indexOf('=') + 1).trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  };
  const remoteInHistory = parseBool('remote-in-history');
  const historyChanged = parseBool('history-changed');
  const noop = isNoopRebase({ remoteInHistory, historyChanged });
  process.stdout.write(noop ? 'NOOP\n' : 'OK\n');
  process.exit(noop ? 3 : 0);
}
