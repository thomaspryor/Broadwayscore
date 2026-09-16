#!/usr/bin/env node
'use strict';
// Repo-wide runner for alert-ledger-commit-check.js (BRO-3662).
//
// The checker itself is a pure function over ONE workflow's YAML; the only
// production caller is scripts/lint-workflow-guards.sh, which shells out to a
// `node -e` one-liner per file. That made "what does the whole repo look like
// right now?" an ad-hoc inline snippet every time — unquotable in a commit
// message, unverifiable in a session log, and easy to get subtly wrong.
//
// Usage: node scripts/lib/scan-alert-ledger-gaps.js
//
// Exit contract (load-bearing — callers key on it):
//   0  scanned a real tree, no violations
//   1  scanned a real tree, violations printed to stdout
//   2  could NOT scan (cannot load the checker, cannot read the dir or a file,
//      or too few workflows to be a real tree) — deliberately NOT 1, because an
//      uncaught throw exits 1 and a broken guard must never be mistaken for a
//      guard that found something.
//
// scanWorkflows() is exported so the three-way contract is unit-testable
// (CLAUDE.md rule 15) — it was previously all top-level code with no
// require.main guard, so nothing could import it and a regression in the exit
// contract would have shipped unnoticed.
const fs = require('fs');
const path = require('path');

// Below this, refuse to render a verdict at all. A workflows directory that
// EXISTS but yields almost no matches — sparse checkout, wrong tree, this file
// vendored elsewhere — would otherwise print "TOTAL VIOLATIONS: 0" and exit 0:
// a guard reporting CLEAN having scanned NOTHING, which is the exact failure
// shape this whole card is about.
//
// SCOPE, stated honestly (review finding): this is an "is this a real workflow
// tree at all" sanity floor, NOT a completeness check. The repo has ~244
// workflow files, so a 60-file partial checkout still passes this and reports on
// ~25% of the tree. Raising the number does not fix that — it just moves the
// line, and a floor above the real count would wedge the scanner the day
// workflows are pruned. If completeness ever needs guaranteeing, compare against
// a committed manifest rather than inflating this constant.
const MIN_EXPECTED_WORKFLOWS = 50;

// GitHub Actions honours BOTH extensions. Matching only .yml would let a future
// `alerting.yaml` with an unstaged-ledger routeAlert() call go unscanned while
// the scanner still printed "TOTAL VIOLATIONS: 0" — the same under-report this
// scanner exists to prevent. (No .yaml files exist today;
// scripts/lint-workflow-guards.sh has the same .yml-only glob, tracked in
// BRO-3671 as a class-level gap.)
// Case-insensitive: a `.YML` file would otherwise be skipped silently, which is
// the same under-report as missing `.yaml` (review finding).
const WORKFLOW_EXT_RE = /\.ya?ml$/i;

// Anything that can move the cursor or split a line once a violation is printed
// (review finding). `\n` splits one finding into two stdout lines so a caller
// counting lines disagrees with TOTAL VIOLATIONS; a bare `\r` is worse, because
// it OVERWRITES the text already on the line and can hide the finding entirely.
//
// C0 + DEL is NOT the whole surface (review finding): NEL (U+0085), LINE
// SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029) are line terminators too,
// and all three were measured PUBLISHING as code 1. They cost nothing to reject
// — every string the real checker emits is fixed ASCII text plus a job name
// captured from [A-Za-z0-9_.-]+, verified zero false positives across all 244
// workflows — so the guard covers them rather than depending on how a
// particular consumer happens to render them.
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/**
 * Describe a thrown value without ever throwing itself (review finding).
 *
 * `err.message` is NOT safe here: a checker can `throw null` / `throw undefined`
 * (property access on those throws), or throw an object whose `.message` is a
 * GETTER that throws, or whose `toString` throws. Any of those made the CATCH
 * HANDLER throw, which escaped scanWorkflows entirely — and since the CLI has no
 * try/catch around the call, node exited 1: "violations found" from a checker
 * that merely exploded. That is the same 2->1 collapse the Array.isArray guard
 * closed one layer up, and it simply moved in here. Measured, not theorised.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  try {
    if (err instanceof Error && typeof err.message === 'string') return err.message;
    if (err === null) return 'null';
    if (err === undefined) return 'undefined';
    const msg = err && err.message;
    if (typeof msg === 'string') return msg;
    return String(err);
  } catch {
    // Even String(err) can throw (Symbol, or a throwing toString/Symbol.toPrimitive).
    return '<unprintable thrown value>';
  }
}

/**
 * Scan a workflows directory. Pure-ish: does IO, but takes its directory and
 * checker as arguments and RETURNS the verdict instead of exiting, so tests can
 * drive every branch of the exit contract.
 *
 * @param {string} dir - directory of workflow files
 * @param {(text: string) => string[]} check - the checker (injected for tests)
 * @returns {{code: 0|1|2, violations: string[], scanned: number, error?: string}}
 */
function scanWorkflows(dir, check) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { code: 2, violations: [], scanned: 0, error: `could not read ${dir}: ${describeError(err)}` };
  }

  // A symlink must be FOLLOWED to decide whether it is a file. Filtering on the
  // dirent's isFile() alone excluded every symlinked workflow (silently
  // under-reporting); accepting every symlink let one POINTING AT A DIRECTORY
  // through to readFileSync, where it throws EISDIR and — with fail-fast below,
  // over a .sort()ed list — could abort the whole scan from an early-sorting
  // name. statSync follows the link and answers the question actually being
  // asked. A broken symlink makes statSync throw, so it is skipped here and
  // cannot wedge the scan; throwIfNoEntry:false returns undefined instead.
  const files = entries
    .filter((e) => {
      if (!WORKFLOW_EXT_RE.test(e.name)) return false;
      if (e.isFile()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isFile() === true;
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort();

  if (files.length < MIN_EXPECTED_WORKFLOWS) {
    return {
      code: 2,
      violations: [],
      // Zero, not files.length: nothing was opened or checked. The count that
      // matters here is already in the message below (review finding).
      scanned: 0,
      error:
        `refusing to report a verdict: found only ${files.length} workflow file(s) in ${dir}, ` +
        `expected at least ${MIN_EXPECTED_WORKFLOWS}. A near-empty scan would report "clean" having scanned nothing.`,
    };
  }

  const violations = [];
  // Files actually READ AND CHECKED, not merely FOUND (review finding). On a
  // mid-scan code-2 return the caller is told how far the scan really got;
  // `files.length` claimed credit for files never opened.
  let scanned = 0;
  for (const file of files) {
    // The filename PREFIXES every violation record (`${file}: ${v}`), so a
    // newline in it splits findings exactly like a newline in the violation
    // does — validating only the checker's string missed half the surface
    // (review finding).
    if (CONTROL_CHAR_RE.test(file)) {
      return { code: 2, violations, scanned, error: `workflow filename contains a control character: ${JSON.stringify(file)}` };
    }

    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      return { code: 2, violations, scanned, error: `could not read ${file}: ${describeError(err)}` };
    }
    try {
      const found = check(text);
      // Array.isArray, not "is it iterable" (review finding). Two real ways a
      // checker can betray this scanner, both of which made it report a verdict
      // it had not earned:
      //   - returns undefined/null (e.g. someone adds an early `return;` for a
      //     no-jobs workflow): iterating threw OUT of this function, the CLI had
      //     no catch, and node exited 1 — "violations found" from a BROKEN
      //     checker, exactly the 2->1 collapse this contract exists to prevent.
      //   - returns a STRING: a string is iterable, so it iterated per CHARACTER
      //     and fabricated one violation per letter (measured: 732 against the
      //     real repo).
      // Both are now "could not scan" (2). The loop lives INSIDE the try so a
      // throw from the iteration itself cannot escape either.
      if (!Array.isArray(found)) {
        return {
          code: 2,
          violations,
          scanned,
          error: `checker returned ${found === null ? 'null' : typeof found} (expected an array) for ${file}`,
        };
      }
      // Elements must be non-empty, SINGLE-LINE strings (review finding). An
      // array of objects stringified to "[object Object]" and an array
      // hole/undefined stringified to "undefined" — a fabricated verdict one
      // layer inside the string bug above (measured: [{job:'x'}] produced 50
      // findings of "[object Object]", and a sparse [,,'x'] produced 150, two
      // thirds of them "undefined").
      //
      // The newline case is the same fabrication by a different route: one
      // violation carrying an embedded \n prints as TWO stdout lines, so anything
      // counting lines disagrees with `TOTAL VIOLATIONS` — the scanner would be
      // over-reporting its own verdict. And the reason is named, because an
      // empty string IS a string: calling that a "non-string" sent the reader
      // hunting for the wrong bug (review finding).
      //
      // `length` is snapshotted and the validated values are COLLECTED, because
      // validating one array and then publishing a second read of it is a hole,
      // not a guard (review finding). A getter or Proxy can answer 'ok' while
      // being validated and `undefined` while being published; a Proxy can
      // report length 0 to the validator and its real length to the publisher;
      // and an array overriding [Symbol.iterator] to yield nothing turns a REAL
      // finding into code 0. Publishing `clean` — the primitives this loop
      // actually saw and approved — closes all three at once, and the snapshot
      // also means a length getter that keeps growing cannot spin forever.
      // `length` is read once, but a snapshot of a LIE is still a lie (review
      // finding). A Proxy answering NaN, undefined or -1 makes `i < n` false on
      // the first test, so validation is skipped entirely and a REAL finding
      // publishes as code 0 — measured: all three returned code 0 over the live
      // 244-workflow tree with a finding present, which is precisely the "clean
      // verdict having scanned nothing" this file exists to prevent. An
      // OBJECT-valued length is worse: `i < n` coerces it on every comparison,
      // so a valueOf() that grows never terminates. typeof is checked first
      // because it cannot trigger that coercion.
      const n = found.length;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
        return {
          code: 2,
          violations,
          scanned,
          error: `checker returned an array whose length is not a non-negative integer (${typeof n}) for ${file}`,
        };
      }
      const clean = [];
      let bad = -1;
      let badReason = '';
      for (let i = 0; i < n; i++) {
        const v = found[i];
        if (typeof v !== 'string') {
          bad = i;
          badReason = `a non-string (${v === null ? 'null' : typeof v})`;
          break;
        }
        if (v === '') {
          bad = i;
          badReason = 'an empty';
          break;
        }
        if (v.includes('\n')) {
          bad = i;
          badReason = 'a multi-line';
          break;
        }
        if (CONTROL_CHAR_RE.test(v)) {
          bad = i;
          badReason = 'a control-character';
          break;
        }
        clean.push(v);
      }
      if (bad !== -1) {
        return {
          code: 2,
          violations,
          scanned,
          error: `checker returned ${badReason} violation at index ${bad} for ${file}`,
        };
      }
      for (const v of clean) violations.push(`${file}: ${v}`);
      scanned++;
    } catch (err) {
      return { code: 2, violations, scanned, error: `checker threw on ${file}: ${describeError(err)}` };
    }
  }

  return { code: violations.length === 0 ? 0 : 1, violations, scanned };
}

module.exports = { scanWorkflows, MIN_EXPECTED_WORKFLOWS, WORKFLOW_EXT_RE };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  let findMissingLedgerCommits;
  try {
    ({ findMissingLedgerCommits } = require('./alert-ledger-commit-check.js'));
  } catch (err) {
    console.error(`could not load alert-ledger-commit-check.js: ${describeError(err)}`);
    process.exitCode = 2;
    return;
  }

  const result = scanWorkflows(path.join(__dirname, '..', '..', '.github', 'workflows'), findMissingLedgerCommits);

  if (result.code === 2) {
    // Nothing goes to STDOUT on a failed scan (review finding): printing the
    // partial violation list while suppressing only the TOTAL line still hands
    // a stdout-parsing caller a list that looks like a verdict. The findings
    // from the files that WERE scanned go to stderr, clearly marked partial.
    console.error(result.error);
    if (result.violations.length) {
      console.error(`(partial — ${result.violations.length} finding(s) before the scan failed, NOT a verdict:)`);
      for (const v of result.violations) console.error(`  ${v}`);
    }
  } else {
    for (const v of result.violations) console.log(v);
    console.log(`TOTAL VIOLATIONS: ${result.violations.length}`);
  }
  // process.exitCode, never process.exit(): stdout is ASYNC when piped and
  // process.exit() truncates it mid-flush. Measured at 60k lines through a pipe,
  // the TOTAL line itself was lost while the exit code stayed correct.
  process.exitCode = result.code;
}
