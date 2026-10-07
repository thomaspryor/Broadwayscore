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
//
// failureType
//   Each failure value also carries the block's `failureType:` diagnostic when
//   one follows the location line ('testCodeFailure', 'subtestsFailed',
//   'cancelledByParent', …). The KEY is unchanged — every existing consumer
//   diffs on `<file>::<name>` exactly as before — but a caller that needs to
//   tell "this file's subtests failed" from "this file crashed at load" (both
//   are `not ok N - <file>` with `location: <file>:1:1` in the nested shape;
//   scripts/lib/land-gate-delta.js, BRO-3873) can read it off the value.

const path = require('node:path');

// Payload capture (BRO-2793). A guard making ONE assertion over MANY inputs
// emits the same `<file>::<name>` key whichever input violated it, so the key
// alone cannot tell a NEW violation from a pre-existing one. The failure's
// `error: |-` body (the assertion message + actual/expected diff) is what
// differs, so it is kept on the value as `payload` — the KEY is unchanged.
// The checkout root is rewritten to `<root>` so a baseline tmpdir and the
// merged tree produce comparable text. The `stack:` block is a separate YAML
// key and is never included (its frames carry line numbers of the test file).

/**
 * @param {string} tapOutput - stdout of `node --test --test-reporter=tap ...`
 * @param {string} treeRoot - absolute path failures' `location:` should be made
 *   relative to (the checkout root the test files were run from)
 * @returns {{failures: Map<string,{file:string,name:string,failureType?:string}>, totals:{tests:number|null,fail:number|null}, sawTap: boolean, unlocated: number}}
 */
function parseTapOutput(tapOutput, treeRoot) {
  const failures = new Map();
  const totals = { tests: null, fail: null };
  let pending = null;
  // The most recently keyed failure, still inside its diagnostic block: the
  // `failureType:` line comes AFTER `location:` in node's TAP output, so it
  // is attached here once the entry already exists.
  let last = null;
  let sawTap = false;
  let unlocated = 0;
  // Open `error:` block: indent of the key line + the entry that owns it.
  let errBlock = null;
  const rootText = treeRoot ? String(treeRoot) : '';
  const closeErr = () => {
    if (errBlock) errBlock.entry.payload = errBlock.lines.join('\n');
    errBlock = null;
  };

  for (const line of String(tapOutput || '').split('\n')) {
    if (errBlock) {
      const indent = /^(\s*)/.exec(line)[1].length;
      if (line.trim() !== '' && indent <= errBlock.indent) closeErr();
      else {
        errBlock.lines.push(rootText ? line.trim().split(rootText).join('<root>') : line.trim());
        continue;
      }
    }
    const errStart = /^(\s*)error:\s*[|>][-+]?\s*$/.exec(line);
    if (errStart && last) {
      errBlock = { indent: errStart[1].length, entry: last, lines: [] };
      continue;
    }
    // A one-line assertion message is emitted as a quoted scalar
    // (`error: 'msg'`), not a block. Without this an aggregate guard with a
    // one-line message has an empty payload, which diffFailingSets reads as
    // NEW on every run — a stale main would block every landing (BRO-4812).
    const errScalar = /^\s*error:\s*(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)")\s*$/.exec(line);
    if (errScalar && last && last.payload === undefined) {
      const text = errScalar[1] !== undefined ? errScalar[1].replace(/''/g, "'") : errScalar[2].replace(/\\(.)/g, '$1');
      last.payload = rootText ? text.split(rootText).join('<root>') : text;
      continue;
    }
    const notOk = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    if (notOk) {
      sawTap = true;
      pending = notOk[1];
      last = null;
      continue;
    }
    if (/^\s*ok \d+ /.test(line)) last = null;
    const ft = /^\s*failureType:\s*'([^']+)'\s*$/.exec(line);
    if (ft && last && !last.failureType) {
      last.failureType = ft[1];
      continue;
    }
    if (pending) {
      const loc = /^\s*location:\s*'(.+?)'\s*$/.exec(line);
      if (loc) {
        const abs = String(loc[1]).replace(/:\d+:\d+$/, '');
        const file = (treeRoot ? path.relative(treeRoot, abs) : abs) || abs;
        last = { file, name: pending };
        failures.set(`${file}::${pending}`, last);
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
  closeErr();
  if (pending) {
    failures.set(`?::${pending}`, { file: '?', name: pending });
    unlocated++;
  }

  return { failures, totals, sawTap, unlocated };
}

module.exports = { parseTapOutput };
