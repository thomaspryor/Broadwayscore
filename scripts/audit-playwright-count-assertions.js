#!/usr/bin/env node
/**
 * audit-playwright-count-assertions.js — catches the "silent no-op" Playwright
 * pattern: `const count = await locator.count()` used to bound a loop
 * (`Math.min(count, N)`) with no assertion that count > 0 first.
 *
 * Why this exists: when the locator's selector drifts (class rename, DOM
 * restructure), count silently becomes 0, the loop body never executes, and
 * the test passes having verified nothing. Two live instances of this shape
 * were found and fixed 2026-07-21 (my-shows-functional.spec.ts:238-239,
 * user-flows.spec.ts:305) — one was the root cause of a recurring CI-red
 * incident (Notion "Test UGC red 5x/day"). Same failure class as this repo's
 * audit-pre2005-reviews.js category-filter incident: a check that looks green
 * but never ran.
 *
 * Detection: for every `const X = await Y.count()` / `let X = await Y.count()`,
 * require an `expect(X` assertion OR an explicit `if (X === 0)` / `if (X > 0)`
 * / `if (!X)` guard within the next few lines. Both are legitimate — the guard
 * form means the author explicitly considered the zero case (e.g. "0 is fine,
 * skip"); the assertion form means the test would fail loudly on drift.
 * Inline uses (`expect(await x.count())...`, `if ((await x.count()) === 0)`)
 * are exempt by construction — there's no bare variable to silently misuse.
 *
 * Usage:
 *   node scripts/audit-playwright-count-assertions.js          # human-readable
 *   node scripts/audit-playwright-count-assertions.js --json   # machine-readable
 *
 * Exit codes:
 *   0 — every count() assignment is guarded
 *   1 — one or more unguarded count() assignments found
 */

const fs = require('fs');
const path = require('path');

const E2E_DIR = path.join(__dirname, '..', 'tests', 'e2e');
const LOOKAHEAD_LINES = 10;

// A new test/describe block boundary — stop scanning forward once we cross
// into the next test, or a guard/assertion from a *different* test could be
// mistaken for coverage of this count().
const BLOCK_BOUNDARY_RE = /^\s*(test|test\.describe|test\.skip|test\.only)\s*\(/;

const ASSIGN_RE = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+.+\.count\(\)\s*;?\s*$/;

function findGuard(lines, startIdx, varName) {
  const expectRe = new RegExp(`expect\\s*\\(\\s*${varName}\\b`);
  const varWordRe = new RegExp(`\\b${varName}\\b`);

  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 1 + LOOKAHEAD_LINES); i++) {
    const line = lines[i];
    if (BLOCK_BOUNDARY_RE.test(line)) break;
    if (expectRe.test(line)) {
      return { line: i + 1, text: line.trim() };
    }
    // An if (...) whose condition references this variable at all — e.g.
    // `if (count === 0)`, `if (count > 0)`, `if (!count)`, or a combined
    // condition like `if (badCount > 0 || goodCount > 0)`. Loose by design:
    // the point is the author explicitly considered this variable in a
    // conditional, not policing which comparison operator they used.
    const ifIdx = line.indexOf('if');
    if (ifIdx !== -1 && /if\s*\(/.test(line) && varWordRe.test(line.slice(ifIdx))) {
      return { line: i + 1, text: line.trim() };
    }
  }
  return null;
}

function auditFile(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGN_RE);
    if (!m) continue;
    const varName = m[1];
    const guard = findGuard(lines, i, varName);
    if (!guard) {
      findings.push({
        file: rel,
        line: i + 1,
        variable: varName,
        text: lines[i].trim(),
      });
    }
  }
  return findings;
}

function main() {
  const jsonMode = process.argv.includes('--json');

  if (!fs.existsSync(E2E_DIR)) {
    console.error(`::error::E2E test dir not found: ${E2E_DIR}`);
    process.exit(2);
  }

  const specFiles = fs
    .readdirSync(E2E_DIR)
    .filter(f => f.endsWith('.spec.ts'))
    .map(f => path.join(E2E_DIR, f));

  const allFindings = specFiles.flatMap(auditFile);

  if (jsonMode) {
    console.log(JSON.stringify({ findings: allFindings, filesScanned: specFiles.length }, null, 2));
  } else {
    console.log(`Scanned ${specFiles.length} spec file(s) under tests/e2e/`);
    if (allFindings.length === 0) {
      console.log('OK — every count() assignment has an expect() or if-guard within range.');
    } else {
      console.log(`Found ${allFindings.length} unguarded count() assignment(s):\n`);
      for (const f of allFindings) {
        console.log(`  ${f.file}:${f.line} — const ${f.variable} = await ...count();`);
        console.log(`    ${f.text}`);
        console.log(
          `    Fix: add \`expect(${f.variable}).toBeGreaterThan(0);\` (or an explicit ` +
          `\`if (${f.variable} === 0) { ... }\` guard if 0 is a legitimate outcome here) ` +
          `before it's used to bound a loop.\n`
        );
      }
    }
  }

  process.exit(allFindings.length > 0 ? 1 : 0);
}

main();
