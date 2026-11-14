// BRO-4500: opening-night tools must read the live review-texts clone, not a stale plain data/review-texts copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveReviewTextsDir } = require('./lib/review-texts-dir.js');

const TOOLS = [
  'verify-review-recovery.js', 'replay-pending-bylines.js', 'check-opening-night-drift.js',
  'check-opening-night-readiness.js', 'opening-night-checklist.js', 'triage-human-review.js',
];

function fixture({ gitInNested }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4500-'));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  const nested = path.join(repo, 'data', 'review-texts', 'show-a');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'a.json'), '{}');
  if (gitInNested) fs.mkdirSync(path.join(repo, 'data', 'review-texts', '.git'));
  fs.mkdirSync(path.join(home, 'broadway-review-texts'), { recursive: true });
  return { repo, home, nested: path.join(repo, 'data', 'review-texts'), legacy: path.join(home, 'broadway-review-texts') };
}
const noMain = { mainWorktree: () => null };

test('plain (non-git) data/review-texts is skipped in favour of the live clone', () => {
  const f = fixture({ gitInNested: false });
  assert.equal(resolveReviewTextsDir({}, f.repo, f.home, noMain), f.legacy);
});

test('a real checkout at data/review-texts is used', () => {
  const f = fixture({ gitInNested: true });
  assert.equal(resolveReviewTextsDir({}, f.repo, f.home, noMain), f.nested);
});

test('every opening-night tool resolves review-texts via the shared helper', () => {
  for (const t of TOOLS) {
    const src = fs.readFileSync(new URL(`./${t}`, import.meta.url), 'utf8');
    assert.match(src, /review-texts-dir/, `${t} must use scripts/lib/review-texts-dir`);
    assert.doesNotMatch(src, /path\.join\([^)]*['"]data['"],\s*['"]review-texts['"]/, `${t} hardcodes data/review-texts`);
    assert.doesNotMatch(src, /__dirname,\s*['"]\.\.\/data\/review-texts/, `${t} hardcodes ../data/review-texts`);
  }
});
