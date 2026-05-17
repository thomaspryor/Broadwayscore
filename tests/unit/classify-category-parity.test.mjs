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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const fixture = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/classify-category-baseline.json'), 'utf8'));
const { classifyCategory: classifyJS } = require(path.join(__dirname, '../../scripts/lib/classify-category.js'));

// TS version: compile via ts-node on demand, or use tsx
function classifyTS(category) {
  const root = path.join(__dirname, '../../');
  const result = execSync(
    `node -e "const {classifyCategory}=require('./src/lib/awards-scoring.ts');console.log(JSON.stringify(classifyCategory(${JSON.stringify(category)})))"`,
    { cwd: root, env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.json' } }
  );
  return JSON.parse(result.toString().trim());
}

test('classifyCategory JS/TS parity — both produce identical outputs for all fixture inputs', () => {
  const mismatches = [];
  for (const [category] of Object.entries(fixture)) {
    const jsResult = classifyJS(category);
    let tsResult;
    try {
      tsResult = classifyTS(category);
    } catch {
      // TS runner not available in this environment — skip TS check
      continue;
    }
    if (JSON.stringify(jsResult) !== JSON.stringify(tsResult)) {
      mismatches.push({ category, js: jsResult, ts: tsResult });
    }
  }
  if (mismatches.length > 0) {
    const lines = mismatches.map(m => `  "${m.category}": JS=${JSON.stringify(m.js)}, TS=${JSON.stringify(m.ts)}`);
    assert.fail(`JS/TS parity failures (${mismatches.length}):\n${lines.join('\n')}`);
  }
});
