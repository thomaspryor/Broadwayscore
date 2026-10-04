// BRO-3500: every workflow that writes data/review-texts/ (the private repo) must
// declare a top-level `concurrency:` group, otherwise two runs race on the same
// checkout. docs/workflow-concurrency-audit.md records the rationale per workflow
// (shared, per-run or per-partition group); this guard stops the gap reopening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wfDir = join(root, '.github', 'workflows');

const writesReviewTexts = (src) =>
  src.includes('uses: ./.github/actions/push-review-texts') || src.includes('cd data/review-texts');

test('audit doc exists', () => {
  assert.ok(existsSync(join(root, 'docs', 'workflow-concurrency-audit.md')));
});

test('every review-texts-writing workflow has a top-level concurrency group', () => {
  const missing = [];
  let checked = 0;
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const src = readFileSync(join(wfDir, f), 'utf8');
    if (!writesReviewTexts(src)) continue;
    checked++;
    if (!/^concurrency:/m.test(src)) missing.push(f);
  }
  assert.ok(checked >= 22, `expected at least 22 review-texts-writing workflows, found ${checked}`);
  assert.deepEqual(missing, [], `workflows writing review-texts without a concurrency group: ${missing.join(', ')}`);
});
