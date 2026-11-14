/**
 * BRO-4126 (BRO-4125 pattern): a test that calls createOrMergeReviewFile with
 * dryRun:true but no reviewTextsDir falls back to the real data/review-texts
 * corpus. Once a real show's real reviews land there matching the test's
 * outlet/critic/url, the test flips from create/new to skipped/no-changes via
 * the unrelated `!changed` path, not the guard it is meant to exercise.
 * Every dry-run call in a test file must pin its own reviewTextsDir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'review-texts') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.test\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function argText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Repo-relative "file:line" of each unpinned dry-run createOrMergeReviewFile call. */
export function findUnpinnedDryRunCalls(files, root = REPO) {
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?<![\w.])createOrMergeReviewFile\s*\(/g)) {
      const args = argText(src, m.index + m[0].length - 1);
      if (/dryRun\s*:\s*true/.test(args) && !/reviewTextsDir/.test(args)) {
        bad.push(`${path.relative(root, f)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  return bad;
}

test('every dry-run createOrMergeReviewFile call in a test pins reviewTextsDir', () => {
  const files = [...walk(path.join(REPO, 'scripts')), ...walk(path.join(REPO, 'tests'))]
    .filter(f => f !== fileURLToPath(import.meta.url));
  assert.deepEqual(findUnpinnedDryRunCalls(files), []);
});

test('detector flags an unpinned dry-run call and accepts a pinned one', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'hermetic-'));
  try {
    const bad = path.join(tmp, 'a.test.mjs');
    const ok = path.join(tmp, 'b.test.mjs');
    fs.writeFileSync(bad, "createOrMergeReviewFile('s', { a: 1 }, { dryRun: true });\n");
    fs.writeFileSync(ok, "createOrMergeReviewFile('s', { a: 1 }, { dryRun: true, reviewTextsDir: d });\n");
    assert.deepEqual(findUnpinnedDryRunCalls([bad, ok], tmp), ['a.test.mjs:1']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
