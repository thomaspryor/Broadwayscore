/**
 * atomic-claim.js — generic per-key atomic claim (mkdir/EEXIST + staleness
 * takeover), extracted from the "acquire a lock so a second process can't
 * double-work the same key" idiom that already existed independently twice
 * in this tree: scripts/bsc-next.js's acquireSuccessionLock/releaseSuccessionLock
 * (per-task succession-depth lock) and scripts/lib/bsc-runner.js's job-lease
 * (per-task headless-runner lease). Task #1896 needed a THIRD one (a
 * per-task claim closing the fresh-dispatch mirror-staleness race) — past the
 * rule-of-three for hand-copying the same 15 lines a third time, so this is
 * the shared primitive all of them should sit on instead. bsc-next.js's
 * succession lock now delegates here (see acquireSuccessionLock); the
 * runner's job-lease has its own richer meta shape (jobId, not just pid/ts)
 * and is left as-is — consolidating it is a separate, lower-value change.
 *
 * fs.mkdirSync is atomic on POSIX: two processes racing to mkdir the same
 * path have exactly one winner, the other gets EEXIST. That's the entire
 * correctness property this module exists to provide — no other guard in
 * this codebase can substitute for it (a read-then-decide-then-write check
 * against any OTHER file, including the dispatch ledger, is a classic TOCTOU
 * race: two readers can both see "not claimed" before either one writes).
 *
 * `now` is injectable (matching dispatch-ledger.js's detectLauncherOutage
 * `{now}` convention) purely so tests can simulate staleness deterministically
 * without real sleeps — production callers omit it and get Date.now().
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_MS = 8 * 60 * 1000; // matches bsc-next.js's pre-existing SUCCESSION_LOCK_STALE_MS

// Returns true (claimed), false (genuinely held by a fresh claim), or
// 'error' (existing claim's meta is unreadable/corrupt — fails CLOSED,
// never guesses a corrupt claim is free).
function acquireClaim(dir, key, opts = {}) {
  const staleMs = opts.staleMs != null ? opts.staleMs : DEFAULT_STALE_MS;
  const now = opts.now != null ? opts.now : Date.now();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort — mkdirSync below still fails informatively */ }
  const p = path.join(dir, `${key}.claim`);
  const meta = { pid: process.pid, ts: now };
  try {
    fs.mkdirSync(p); // atomic: EEXIST iff another process's mkdirSync already won
    fs.writeFileSync(path.join(p, 'meta.json'), JSON.stringify(meta));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return 'error';
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8'));
      // BRO-395: existing.ts <= now is required, not just now - existing.ts <
      // staleMs — a future-dated (corrupt/clock-skewed) existing.ts would
      // otherwise make `now - existing.ts` negative, always < staleMs, and
      // read as "fresh" forever, wedging this claim permanently instead of
      // letting a stale-takeover ever happen. A future existing.ts is treated
      // as untrustworthy, not fresh, so it falls straight to takeover below —
      // same direction as the file's own KNOWN GAP above: takeover here is
      // already not ownership-token-gated, so this doesn't introduce new risk.
      if (existing.ts <= now && now - existing.ts < staleMs) return false; // fresh — genuinely held elsewhere
      fs.writeFileSync(path.join(p, 'meta.json'), JSON.stringify(meta)); // stale — take over
      return true;
    } catch (readErr) {
      // ENOENT specifically (task #1896 CI catch): mkdirSync(p) and the
      // meta.json write are two separate syscalls, not one atomic unit — a
      // concurrent reader can win the EEXIST race against a WINNER that
      // hasn't finished writing its meta.json yet. That's a legitimate
      // "held, try again shortly" case, not corruption: the directory exists
      // (someone won), there's just nothing to read YET. Observed live: two
      // real dispatchers hitting the same task id in the same instant, one
      // read this exact window and got told "corrupt" when the correct
      // answer was "held, not stale". Any OTHER read failure (malformed
      // JSON, EACCES) still means a genuinely unreadable claim — fail closed.
      if (readErr.code === 'ENOENT') return false;
      return 'error'; // unreadable meta — fail closed
    }
  }
}

// KNOWN GAP (inherited from bsc-next.js's pre-extraction acquireSuccessionLock,
// BRO-2251): release is keyed on `key` alone, not an ownership token
// (pid/nonce). If a holder's own attempt runs past staleMs before releasing,
// a second caller's stale-takeover can acquire the "same" claim, and the
// FIRST holder's deferred release then deletes the second holder's claim out
// from under it. Not fixed here (both succession's and this module's every
// caller inherit it) — closing it needs an ownership check (compare pid/nonce
// before rm, not just key), a separate, testable change of its own.
function releaseClaim(dir, key) {
  try { fs.rmSync(path.join(dir, `${key}.claim`), { recursive: true, force: true }); } catch { /* next attempt's staleness check recovers */ }
}

module.exports = { acquireClaim, releaseClaim, DEFAULT_STALE_MS };
