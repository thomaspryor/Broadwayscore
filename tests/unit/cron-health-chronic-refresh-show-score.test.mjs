// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the extractor/checker
// under test never reads data/*.json; synthetic YAML fixtures only. The one
// live-repo test at the bottom reads real .github/workflows/*.yml files by
// design (regression guard), not derived data.
/**
 * BRO-450 — "Cron stale 3+ consecutive days: Refresh Show Score
 * (opening-night)" kept re-firing because check-cron-health.yml's own
 * "Resolve recovered cron conditions" step was permanently broken: its
 * inline `node -e '...'` body contained a bare apostrophe ("sit out the
 * previous incident's 168h cooldown") inside a bash single-quoted string.
 * Bash single-quotes have no escape mechanism, so that apostrophe closed
 * the string early and fed a truncated, invalid fragment to `node -e`,
 * which threw `SyntaxError: Unexpected end of input` on EVERY invocation
 * (confirmed via `gh run view 32253007200 --log-failed` — the exact run
 * linked from the Linear card). Because this was a parse-time failure,
 * `resolveCondition('cron-health-chronic:<name>')` never executed for ANY
 * cron, ever, so the chronic-stale escalation condition could never
 * self-clear via its intended recovery path.
 *
 * This test file:
 *  1. Regression-guards the actual fix in check-cron-health.yml.
 *  2. Exercises the real detector (scripts/lib/audit-workflow-hygiene-
 *     rules.js's extractSingleQuotedEvalBodies + scripts/audit-workflow-
 *     hygiene.js's findUnescapedApostrophesInSingleQuotedEval, rule (j))
 *     against synthetic fixtures reproducing both the bug and known-tricky
 *     non-bug patterns this repo actually uses (quote-concatenation asides,
 *     `$(...)`/argv-passing closers, ESM `--input-type=module` evals) — so
 *     the detector doesn't regress into false positives/negatives.
 *  3. Runs the detector across every real .github/workflows/*.yml file, the
 *     repo-wide form of this same check (a second real instance in
 *     update-show-status.yml was found and fixed by this exact rule during
 *     BRO-450 — this assertion is what keeps that class of bug from
 *     recurring anywhere, not just in the one file the card named).
 *
 * Pattern: require() the real functions; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractSingleQuotedEvalBodies } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const { findUnescapedApostrophesInSingleQuotedEval } = require('../../scripts/audit-workflow-hygiene.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

const synthetic = (body) => `
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve recovered cron conditions
        run: |
${body}
`;

describe('findUnescapedApostrophesInSingleQuotedEval (rule j)', () => {
  test('flags the exact BRO-450 bug: a possessive apostrophe at end-of-line inside a comment', () => {
    const raw = synthetic(`          node -e '
            const { resolveCondition } = require("./scripts/lib/owner-alert-router.js");
            const names = (process.env.RECOVERED_NAMES || "").split(";").map(s => s.trim()).filter(Boolean);
            for (const name of names) {
              resolveCondition("cron-health:" + name);
              // this a cron that flaps would sit out the previous incident's
              // 168h cooldown before its NEXT multi-day outage could escalate.
              resolveCondition("cron-health-chronic:" + name);
            }
          '`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.strictEqual(violations.length, 1);
    assert.match(violations[0].message, /SyntaxError/);
  });

  test('does NOT flag the fixed check-cron-health.yml phrasing (no apostrophe)', () => {
    const raw = synthetic(`          node -e '
            const { resolveCondition } = require("./scripts/lib/owner-alert-router.js");
            const names = (process.env.RECOVERED_NAMES || "").split(";").map(s => s.trim()).filter(Boolean);
            for (const name of names) {
              resolveCondition("cron-health:" + name);
              // this a cron that flaps would sit out the prior-incident 168h
              // cooldown before its NEXT multi-day outage could escalate.
              resolveCondition("cron-health-chronic:" + name);
            }
          '`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a quote-concatenation aside that round-trips (no whitespace at any quote boundary)', () => {
    // Real pattern from check-cron-health.yml's "Notify — stale critical
    // crons" step: a comment with a balanced quoted aside butted directly
    // up against the surrounding quotes on both sides — bash reconstructs
    // this as ONE unbroken shell word even though it toggles quote state
    // twice more along the way.
    const raw = synthetic(`          node -e '
            const result = { action: "digest" };
            // result.action==='digest' means the page-worthy gate downgraded
            // this from 'human' — the owner WILL see it in the next digest.
            console.log(result.action);
          '`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a $(...) command-substitution closer (trailing bare quote then paren)', () => {
    const raw = synthetic(`          SHOWS=$(node -e '
            const data = { shows: [{ id: "a" }] };
            console.log(data.shows.map(s => s.id).join(","));
          ')`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag an argv-passing closer (bare quote, space, then a quoted shell var)', () => {
    const raw = synthetic(`          UNSCORED=$(node -e '
            const shows = process.argv[1] ? process.argv[1].split(",") : [];
            console.log(shows.length);
          ' "$SHOWS")`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a valid ESM eval using --input-type=module', () => {
    const raw = synthetic(`          node --input-type=module -e '
            import { readFileSync } from "node:fs";
            console.log(readFileSync("/tmp/x.txt", "utf8"));
          '`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('flags a genuinely broken ESM eval body too (still validated for syntax)', () => {
    const raw = synthetic(`          node --input-type=module -e '
            import { readFileSync } from "node:fs";
            const x = 1 +
          '`);
    const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
    assert.strictEqual(violations.length, 1);
  });
});

describe('extractSingleQuotedEvalBodies (pure extractor)', () => {
  test('reconstructs the full body across a benign re-entered quote (the "digest"/"human" case)', () => {
    // Bash strips the quote delimiters themselves — "digest"/"human" survive
    // as literal unquoted text, but the quote MARKS around them do not.
    const raw = synthetic(`          node -e '
            // a===digest b=human c
          '`);
    const bodies = extractSingleQuotedEvalBodies(raw);
    assert.strictEqual(bodies.length, 1);
    assert.match(bodies[0].body, /a===digest b=human c/);
  });

  test('excludes the trailing $(...) close-paren from the extracted body (only the real JS content remains)', () => {
    const raw = synthetic(`          SHOWS=$(node -e '
            console.log(1);
          ')`);
    const bodies = extractSingleQuotedEvalBodies(raw);
    assert.strictEqual(bodies.length, 1);
    assert.ok(bodies[0].body.trim().endsWith('console.log(1);'));
  });
});

describe('repo-wide regression guard (the actual BRO-450 acceptance criterion)', () => {
  test('every current .github/workflows/*.yml file has zero unescaped-apostrophe eval violations', () => {
    const files = fs
      .readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    assert.ok(files.length > 0, 'expected to find workflow files');

    const offenders = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
      if (raw.includes('hygiene-quote-apostrophe-ok:')) continue;
      const violations = findUnescapedApostrophesInSingleQuotedEval(raw);
      if (violations.length > 0) {
        offenders.push({ file, violations });
      }
    }

    assert.deepStrictEqual(
      offenders,
      [],
      `Found unescaped-apostrophe eval bugs: ${JSON.stringify(offenders, null, 2)}`,
    );
  });
});
