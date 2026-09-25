// Class guard: a script must not call safeWriteReview() and then delete the
// source in the next few lines. safeWriteReview reports refusals (locked,
// quarantined, sparse-hidden or conflict-marked target) as {wrote:false}, so
// ignoring the result and unlinking the source loses the review. Use
// writeReviewOrThrow() for move/merge-then-delete (review 2026-09-25 found
// this in rebuild-all-reviews.js, merge-slug-directories.js and
// audit-we-market-misroutes.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WINDOW = 10;

function sources() {
  const out = [];
  for (const dir of ['scripts', 'scripts/lib']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/\.(c?js|mjs)$/.test(f) || /\.test\./.test(f)) continue;
      out.push(path.join(dir, f));
    }
  }
  return out;
}

test('no safeWriteReview() call is followed by a source unlink without checking the result', () => {
  const offenders = [];
  for (const rel of sources()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Bare statement call: the result is discarded.
      if (!/^\s*safeWriteReview\(/.test(line)) return;
      const next = lines.slice(i + 1, i + 1 + WINDOW);
      const unlinkAt = next.findIndex(l => /\b(unlinkSync|rmSync)\(/.test(l));
      if (unlinkAt === -1) return;
      // A closing brace at the call's indentation or shallower ends the block;
      // an unlink after that is a different code path.
      const indent = line.match(/^\s*/)[0].length;
      const blockEnd = next.findIndex(l => /^\s*}/.test(l) && l.match(/^\s*/)[0].length < indent);
      if (blockEnd !== -1 && blockEnd < unlinkAt) return;
      offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use writeReviewOrThrow() before deleting the source:\n${offenders.join('\n')}`);
});
