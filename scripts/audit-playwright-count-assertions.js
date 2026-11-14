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
 * incident (Notion "Test UGC red 5x/day"). A third instance was found by
 * this script's own review pass in tests/e2e/helpers/layout-assertions.ts
 * (getInteractiveBounds / assertRowAlignment — a 0 count let three shared
 * assert helpers pass trivially), which is why helper *.ts files are
 * in-scope below, not just *.spec.ts. Same failure class as this repo's
 * audit-pre2005-reviews.js category-filter incident: a check that looks
 * green but never ran.
 *
 * Detection: for every `const X = await Y.count()` / `let X = await Y.count()`
 * (single- or two-line form, with or without a `: number` type annotation),
 * require an `expect(X` / `expect.soft(X` / `expect.poll(X` assertion OR an
 * explicit `if (X === 0)` / `if (X > 0)` / `if (!X)` guard within the next
 * few lines. Both are legitimate — the guard form means the author
 * explicitly considered the zero case (e.g. "0 is fine, skip"); the
 * assertion form means the test would fail loudly on drift. Inline uses
 * (`expect(await x.count())...`, `if ((await x.count()) === 0)`) are exempt
 * by construction — there's no bare variable to silently misuse. Comments
 * are stripped before matching so a commented-out `// expect(count)...`
 * doesn't count as coverage.
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

// Single-line form: `const count = await locator.count();` (optional
// `: type` annotation between the name and `=`).
const ASSIGN_RE = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*\w+\s*)?=\s*await\s+.+\.count\(\)\s*;?\s*$/;
// Two-line form: the assignment starts here but doesn't close — e.g.
// `const count = await\n  locator.count();` or `const count =\n  await locator.count();`
const ASSIGN_OPEN_RE = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*\w+\s*)?=\s*(?:await)?\s*$/;
const COUNT_CALL_RE = /\.count\(\)\s*;?\s*$/;

function stripComments(line) {
  // Crude single-line strip — matches the convention in the sibling
  // audit-playwright-evaluate-click.js. Enough to skip `// expect(count)...`
  // (a commented-out, dead assertion) counting as real guard coverage.
  let out = line.replace(/\/\*[\s\S]*?\*\//g, '');
  const slashSlash = out.indexOf('//');
  if (slashSlash >= 0) out = out.slice(0, slashSlash);
  return out;
}

function findGuard(lines, startIdx, varName) {
  // `expect(count...`, `expect.soft(count...`, `expect.poll(count...`.
  const expectRe = new RegExp(`expect(?:\\.\\w+)?\\s*\\(\\s*${varName}\\b`);
  // Word-boundary match on the variable name, but NOT when it's a property
  // access on something else (`options.count`, `this.count`) — a negative
  // lookbehind for a preceding `.` keeps an unrelated same-named property
  // from being mistaken for the local variable being guarded.
  const varWordRe = new RegExp(`(?<!\\.)\\b${varName}\\b`);

  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 1 + LOOKAHEAD_LINES); i++) {
    const line = stripComments(lines[i]);
    if (BLOCK_BOUNDARY_RE.test(line)) break;
    // Stitch this line with the next 2 so a multi-line `expect(\n  count,\n  msg\n)`
    // call (Playwright's own style for an assertion with a failure message)
    // still matches — mirrors audit-playwright-evaluate-click.js's 3-line window.
    const window = [line, lines[i + 1], lines[i + 2]].filter(Boolean).join(' ');
    if (expectRe.test(window)) {
      return { line: i + 1, text: lines[i].trim() };
    }
    // An if (...) whose condition references this variable at all — e.g.
    // `if (count === 0)`, `if (count > 0)`, `if (!count)`, or a combined
    // condition like `if (badCount > 0 || goodCount > 0)`. Loose by design:
    // the point is the author explicitly considered this variable in a
    // conditional, not policing which comparison operator they used.
    const ifIdx = line.indexOf('if');
    if (ifIdx !== -1 && /if\s*\(/.test(line) && varWordRe.test(line.slice(ifIdx))) {
      return { line: i + 1, text: lines[i].trim() };
    }
  }
  return null;
}

function auditFile(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  const rawLines = fs.readFileSync(filePath, 'utf8').split('\n');
  const lines = rawLines.map(stripComments);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    let varName = null;

    const m = lines[i].match(ASSIGN_RE);
    if (m) {
      varName = m[1];
    } else {
      // Two-line form: this line opens the assignment, the next line closes
      // it with the `.count()` call.
      const openM = lines[i].match(ASSIGN_OPEN_RE);
      if (openM && lines[i + 1] && COUNT_CALL_RE.test(lines[i + 1]) && !lines[i + 1].includes('=')) {
        varName = openM[1];
      }
    }
    if (!varName) continue;

    const guard = findGuard(lines, i, varName);
    if (!guard) {
      findings.push({
        file: rel,
        line: i + 1,
        variable: varName,
        text: rawLines[i].trim(),
      });
    }
  }
  return findings;
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // __screenshots__ holds baseline fixtures, not source — skip it.
      if (entry.name === '__screenshots__') continue;
      out.push(...walk(fp));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(fp);
    }
  }
  return out;
}

function main() {
  const jsonMode = process.argv.includes('--json');

  if (!fs.existsSync(E2E_DIR)) {
    console.error(`::error::E2E test dir not found: ${E2E_DIR}`);
    process.exit(2);
  }

  const scanFiles = walk(E2E_DIR);
  const allFindings = scanFiles.flatMap(auditFile);

  if (jsonMode) {
    console.log(JSON.stringify({ findings: allFindings, filesScanned: scanFiles.length }, null, 2));
  } else {
    console.log(`Scanned ${scanFiles.length} file(s) under tests/e2e/`);
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
