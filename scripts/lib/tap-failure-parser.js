#!/usr/bin/env node
'use strict';
//
// tap-failure-parser.js — parse `node --test --test-reporter=tap` output into a
// failure set keyed `<repo-relative-file>::<test name>` (CLAUDE.md §15: extracted
// so the technique has exactly one implementation, not one per caller).
//
// ORIGIN
//   Lifted from scripts/audit-time-bomb-tests.js's runSuite() (task #1286),
//   which needs this to diff a baseline run's failing set against a
//   clock-shifted run's. scripts/lib/merge-post-merge-test-gate.js (card #1433)
//   needs the identical technique to diff a pre-merge baseline's failing set
//   against the post-merge tree's, so this is the shared home for both.
//
// WHY KEYED BY FILE, NOT BARE NAME
//   Test titles are not unique across a suite — e.g. "two child processes
//   racing to save both land without corrupting the file" appears verbatim in
//   multiple *-write-guard.test.mjs files. Node's TAP reporter emits a
//   `location: '<abs path>:<line>:<col>'` YAML line inside each failure's
//   diagnostic block; stripped of :line:col and made repo-relative, that gives
//   a key that survives across two DIFFERENT checkouts of the same repo-
//   relative path (e.g. a baseline tmpdir vs. the shared main worktree).
//
// UNLOCATED FALLBACK
//   A failure whose TAP block never emits a location: line (rare, but observed)
//   falls back to a `?::<name>` key. Two such failures sharing a title collapse
//   into one key — surfaced via the returned `unlocated` count rather than
//   hidden, so a caller doing before/after diffing can decide how to treat it.

const path = require('node:path');

/**
 * @param {string} tapOutput - stdout of `node --test --test-reporter=tap ...`
 * @param {string} treeRoot - absolute path failures' `location:` should be made
 *   relative to (the checkout root the test files were run from)
 * @returns {{failures: Map<string,{file:string,name:string}>, totals:{tests:number|null,fail:number|null}, sawTap: boolean, unlocated: number}}
 */
function parseTapOutput(tapOutput, treeRoot) {
  const failures = new Map();
  const totals = { tests: null, fail: null };
  let pending = null;
  let sawTap = false;
  let unlocated = 0;

  for (const line of String(tapOutput || '').split('\n')) {
    const notOk = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    if (notOk) {
      sawTap = true;
      pending = notOk[1];
      continue;
    }
    if (pending) {
      const loc = /^\s*location:\s*'(.+?)'\s*$/.exec(line);
      if (loc) {
        const abs = String(loc[1]).replace(/:\d+:\d+$/, '');
        const file = (treeRoot ? path.relative(treeRoot, abs) : abs) || abs;
        failures.set(`${file}::${pending}`, { file, name: pending });
        pending = null;
        continue;
      }
      // Next failure (or a passing `ok N`) started before we saw a location —
      // this failure's diagnostic block never carried one.
      if (/^\s*not ok |^\s*ok \d+ /.test(line)) {
        failures.set(`?::${pending}`, { file: '?', name: pending });
        unlocated++;
        pending = null;
      }
    }
    const t = /^# tests (\d+)$/.exec(line);
    if (t) {
      totals.tests = Number(t[1]);
      sawTap = true;
      continue;
    }
    const f = /^# fail (\d+)$/.exec(line);
    if (f) totals.fail = Number(f[1]);
  }
  if (pending) {
    failures.set(`?::${pending}`, { file: '?', name: pending });
    unlocated++;
  }

  return { failures, totals, sawTap, unlocated };
}

module.exports = { parseTapOutput };
