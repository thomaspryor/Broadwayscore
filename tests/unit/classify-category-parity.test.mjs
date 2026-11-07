/**
 * Parity canary: JS (scripts/lib/classify-category.js) and TS
 * (src/lib/awards-scoring.ts) must produce identical outputs for every
 * category in the golden fixture.
 *
 * The TS version is compiled to JS at build time; this test ensures neither
 * copy drifts away from the other. Drift caused mis-tiering in 2026-05-16
 * when DD 70th patterns were added to TS but not JS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const fixture = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/classify-category-baseline.json'), 'utf8'));
const { classifyCategory: classifyJS } = require(path.join(__dirname, '../../scripts/lib/classify-category.js'));

// Classify every fixture category through the TS implementation in ONE tsx
// process — avoids per-call shell escaping that previously silently swallowed
// every iteration. If tsx isn't installed the test FAILS (no silent skip).
function classifyAllTS(categories) {
  const root = path.join(__dirname, '../../');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'classify-parity-'));
  const catsPath = path.join(tmp, 'cats.json');
  const runnerPath = path.join(tmp, 'runner.mjs');
  writeFileSync(catsPath, JSON.stringify(categories));
  writeFileSync(runnerPath, `
    import { readFileSync } from 'node:fs';
    import { classifyCategory } from '${path.join(root, 'src/lib/awards-scoring.ts').replace(/\\/g, '/')}';
    const cats = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const out = {};
    for (const c of cats) out[c] = classifyCategory(c) ?? null;
    process.stdout.write(JSON.stringify(out));
  `);
  try {
    const result = execFileSync('node', ['--import', 'tsx', runnerPath, catsPath], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(result.toString().trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('classifyCategory JS/TS parity — both produce identical outputs for all fixture inputs', () => {
  const categories = Object.keys(fixture);
  const tsResults = classifyAllTS(categories);
  const mismatches = [];
  for (const category of categories) {
    const jsResult = classifyJS(category) ?? null;
    const tsResult = tsResults[category];
    if (JSON.stringify(jsResult) !== JSON.stringify(tsResult)) {
      mismatches.push({ category, js: jsResult, ts: tsResult });
    }
  }
  if (mismatches.length > 0) {
    const lines = mismatches.map(m => `  "${m.category}": JS=${JSON.stringify(m.js)}, TS=${JSON.stringify(m.ts)}`);
    assert.fail(`JS/TS parity failures (${mismatches.length}):\n${lines.join('\n')}`);
  }
});
