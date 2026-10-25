// Class guard: a script must not call safeWriteReview() and then delete the
// source without checking the write landed. safeWriteReview reports refusals
// (sparse-hidden or conflict-marked target, quarantine) as {wrote:false}, so
// ignoring the result and unlinking the source can lose the review. Use
// writeReviewOrThrow() for move/merge-then-delete, or check the assigned
// result's .wrote / .quarantinedPath before deleting (review 2026-09-25 found
// this in rebuild-all-reviews.js, merge-slug-directories.js,
// audit-we-market-misroutes.js and cleanup-phantom-outlets.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WINDOW = 25;
const DELETE_RE = /\b(unlinkSync|rmSync|safeUnlinkReview)\(/;

function sources(dir = 'scripts', out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'fixtures') continue;
      sources(rel, out);
    } else if (/\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

export function findOffenders(text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const bare = /^\s*(?:if\s*\(.*\)\s*)?safeWriteReview\(/.test(line);
    const assigned = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*safeWriteReview\(/) || line.match(/^\s*(\w+)\s*=\s*safeWriteReview\(/);
    if (!bare && !assigned) return;
    const next = lines.slice(i + 1, i + 1 + WINDOW);
    const delAt = next.findIndex(l => DELETE_RE.test(l));
    if (delAt === -1) return;
    const indent = line.match(/^\s*/)[0].length;
    const blockEnd = next.findIndex(l => /^\s*}/.test(l) && l.match(/^\s*/)[0].length < indent);
    if (blockEnd !== -1 && blockEnd < delAt) return;
    if (assigned) {
      const v = assigned[1];
      const checked = next.slice(0, delAt).some(l => new RegExp(`\\b${v}\\.(wrote|quarantinedPath)\\b`).test(l));
      if (checked) return;
    }
    hits.push(i + 1);
  });
  return hits;
}

test('no safeWriteReview() result is ignored before deleting a source file', () => {
  const offenders = [];
  for (const rel of sources()) {
    for (const ln of findOffenders(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) offenders.push(`${rel}:${ln}`);
  }
  assert.deepEqual(offenders, [], `use writeReviewOrThrow() or check .wrote/.quarantinedPath before deleting:\n${offenders.join('\n')}`);
});

test('detector catches bare, assigned-unchecked and safeUnlinkReview shapes; passes checked ones', () => {
  assert.deepEqual(findOffenders('  safeWriteReview(a, d);\n  fs.unlinkSync(src);\n'), [1]);
  assert.deepEqual(findOffenders('  const r = safeWriteReview(a, d);\n  if (r.lockedSkipped) {}\n  safeUnlinkReview(src);\n'), [1]);
  assert.deepEqual(findOffenders('  const r = safeWriteReview(a, d);\n  if (r.wrote === false) return;\n  fs.unlinkSync(src);\n'), []);
  assert.deepEqual(findOffenders('  writeReviewOrThrow(a, d);\n  fs.unlinkSync(src);\n'), []);
});
