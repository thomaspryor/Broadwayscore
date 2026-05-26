#!/usr/bin/env node
/**
 * audit-playwright-evaluate-click.js
 *
 * Mechanical guard against the "synthesized DOM .click() inside browser
 * context" anti-pattern in Playwright tests.
 *
 * The bug:
 *   await page.evaluate(() => {
 *     document.querySelector('button').click();  // ← bypasses Playwright actionability
 *   });
 *
 * Why it's bad: a synthesized DOM .click() fires immediately whether or
 * not React/Vue/etc. has attached an onClick handler. On hydration-heavy
 * pages, the click silently no-ops and the test continues with stale
 * state. Tests pass by luck; later layout shifts that delay hydration
 * flip them red without any "real" change. (2026-05-26 regression:
 * filter-panel-sync.spec.ts went red after an unrelated homepage commit.)
 *
 * Detection: any line in tests/e2e/ that calls `.click()` on a
 * `document.querySelector*` / `document.getElementBy*` result. These
 * `document.*` APIs ONLY work inside a browser-side evaluate body (the
 * test runner has no DOM), so the syntactic context doesn't need to
 * be parsed — the call shape is the signal.
 *
 * Exemption: `// EVALUATE-CLICK-EXEMPT: <reason>` on the same line or
 * one line above the .click(). Reviewers should challenge new exemptions.
 *
 * Exit: 0 clean, 1 violations.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'tests', 'e2e');
const EXEMPT_MARKER = /\/\/\s*EVALUATE-CLICK-EXEMPT:\s*\S+/;

// Match a synthesized click: any `document.querySelector*(...).click(`
// or `document.getElementBy*(...).click(`, possibly with optional-chain
// (`?.click(`) and possibly with `as HTMLButtonElement` style casts in
// the middle. Captures the whole call expression for the error message.
const SYNTHESIZED_CLICK = /document\s*\.\s*(?:querySelector(?:All)?|getElementBy(?:Id|ClassName|TagName|Name))\b[\s\S]*?[?]?\.click\s*\(/;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(fp));
    else if (entry.isFile() && /\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(fp);
  }
  return out;
}

function stripComments(line) {
  // Crude single-line strip — enough to skip `// ...` mentions of the
  // pattern (e.g. in a doc comment quoting the anti-pattern). Block
  // comments are matched line-by-line so a single-line `/* … */` works,
  // but multi-line block comments referencing the pattern in prose would
  // need a real tokenizer. Use the EVALUATE-CLICK-EXEMPT marker for those.
  let out = line.replace(/\/\*[\s\S]*?\*\//g, '');
  const slashSlash = out.indexOf('//');
  if (slashSlash >= 0) out = out.slice(0, slashSlash);
  return out;
}

function findViolations(source, file) {
  const violations = [];
  const lines = source.split('\n');
  // Look across consecutive lines so a chained call broken over multiple
  // lines (e.g. `document.querySelector('x')\n  ?.click();`) still matches.
  for (let i = 0; i < lines.length; i++) {
    // Stitch up to 3 lines together for cross-line chains.
    const window = stripComments(lines.slice(i, i + 3).join(' '));
    const m = window.match(SYNTHESIZED_CLICK);
    if (!m) continue;
    const thisLine = lines[i] || '';
    const prevLine = i > 0 ? lines[i - 1] : '';
    // Exemption can sit on the line itself OR the line above the .click().
    // Find which line the .click() actually lives on, accept exemption on either.
    let clickLineNum = i;
    for (let j = 0; j < 3; j++) {
      if ((lines[i + j] || '').includes('.click(')) { clickLineNum = i + j; break; }
    }
    const clickLine = lines[clickLineNum] || '';
    const clickPrev = clickLineNum > 0 ? lines[clickLineNum - 1] : '';
    if (EXEMPT_MARKER.test(clickLine) || EXEMPT_MARKER.test(clickPrev)) continue;
    violations.push({
      file,
      line: clickLineNum + 1,
      snippet: clickLine.trim() || lines[i].trim(),
    });
    // Skip ahead past this hit so we don't double-count on the next window.
    i = clickLineNum;
  }
  return violations;
}

function main() {
  const files = walk(ROOT);
  const all = [];
  for (const fp of files) {
    const src = fs.readFileSync(fp, 'utf8');
    if (!src.includes('document.')) continue;
    if (!src.includes('.click(')) continue;
    all.push(...findViolations(src, fp));
  }
  if (all.length === 0) {
    console.log(`OK: ${files.length} e2e files scanned; no synthesized document.querySelector*.click() found.`);
    return;
  }
  console.error(`\nFound ${all.length} synthesized .click() on document.querySelector* in tests/e2e/ (hydration race risk):\n`);
  for (const v of all) {
    console.error(`  ${path.relative(path.join(__dirname, '..'), v.file)}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(`
Why this fails:
  document.querySelector(...).click() inside a Playwright page.evaluate
  (or any browser-side callback) fires a synthesized DOM click that
  bypasses Playwright's actionability checks. React's onClick handler
  may not be attached yet on hydration-heavy pages — the click "works"
  but does nothing. Tests pass by luck until layout shifts elsewhere
  slow hydration. 2026-05-26: filter-panel-sync.spec.ts West End went
  red after an unrelated homepage commit slowed hydration just enough.

How to fix:
    // PREFER (Playwright actionable click — waits for attached/visible/stable):
    await page.getByRole('button', { name: 'X' }).click();
    await page.locator('button').filter({ hasText: 'X' }).click();

    // OR (when scoping requires picking one of many same-text buttons):
    const handle = await page.waitForFunction(
      ({ label, scope }) => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(b => /* … scope predicate … */) ?? null;
      },
      { label, scope },
      { timeout: 5000 }
    );
    await handle.asElement().click();   // goes through Playwright actionability

Escape hatch:
  Add // EVALUATE-CLICK-EXEMPT: <reason> on the .click() line or the
  line above it. Reviewers should challenge any new exemption.
`);
  process.exit(1);
}

main();
