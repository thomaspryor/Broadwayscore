// Static no-undef gate over scripts/**/*.js (BRO-104).
//
// Why this exists: on 2026-08-14 two sessions touched the same import block in
// scripts/scrape-lottery-rush.js six hours apart. The first (6a1563c4f39) added
// `const { isBroadwayCategory } = require('./lib/venue-classification')`; the
// second (2cce8893917, the BRO-218 premium_proxy migration) rewrote the block
// and dropped that line. Nothing caught it: `node --check` only parses, the
// script has no unit test, and the call site is at module scope so it throws
// ReferenceError at load. The failure surfaced two days later as a red cron,
// and by the time anyone looked, data/lottery-rush.json was 6 days stale and
// the daily health digest was reporting an ERROR.
//
// A missing/typo'd identifier is a whole-file crash that no amount of review
// reliably catches but that a linter catches for free. Sweeping the fixed
// version surfaced 7 MORE of the same bug already sitting in main, one of them
// inside a bare `catch {}` where it had been silently swallowed for weeks.
//
// The gate is at ZERO — there is no baseline allowlist. If this test fails, a
// script references something that does not exist; fix the import, don't add
// an exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ESLint } = require('eslint');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('no script references an undefined identifier', async () => {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    useEslintrc: false, // .eslintrc.json is next/core-web-vitals — it does not cover scripts/
    overrideConfig: {
      // `browser` is on because many scrapers pass page.evaluate() callbacks
      // that legitimately touch document/window/navigator. Those run in the
      // page, not in node, so they are not bugs.
      env: { node: true, browser: true, es2022: true },
      parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
      rules: { 'no-undef': 'error' },
    },
    errorOnUnmatchedPattern: false,
  });

  const results = await eslint.lintFiles(['scripts/**/*.js']);
  assert.ok(results.length > 500, `expected to lint the whole scripts/ tree, only saw ${results.length} files`);

  const violations = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.ruleId !== 'no-undef') continue;
      violations.push(`${path.relative(REPO_ROOT, r.filePath)}:${m.line} — ${m.message}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `${violations.length} undefined identifier(s) — each is a ReferenceError the first time that line runs:\n  ` +
      violations.join('\n  ') +
      '\n\nFix the missing require/declaration. Do NOT add an allowlist: this gate is at zero on purpose.'
  );
});
