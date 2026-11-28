import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BRO-2613: every audit that skips on bare duplicateTextOf must carry a pointer to
// docs/duplicate-text-of-exclusion.md. A new site, or a removed pointer, fails here
// so the "advisory skip, not a scoring claim" review is redone.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = 'docs/duplicate-text-of-exclusion.md';
const EXPECTED = { 'audit-review-duplicates.js': 2, 'audit-opening-night-extraction.js': 1, 'audit-url-collisions.js': 1 };

test('doc exists', () => assert.ok(fs.existsSync(path.join(root, DOC))));

for (const [name, n] of Object.entries(EXPECTED)) {
  const file = `scripts/${name}`; // built, not a literal: the yml-coverage audit would otherwise demand test.yml path entries (shared infra)
  test(`${file}: every bare duplicateTextOf skip is annotated`, () => {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    const skips = lines.map((l, i) => [l, i]).filter(([l]) => /duplicateTextOf/.test(l) && /\bcontinue;/.test(l));
    assert.equal(skips.length, n, `${file}: expected ${n} duplicateTextOf skips, found ${skips.length}; review per ${DOC}`);
    for (const [, i] of skips) assert.match(lines[i - 1], /BRO-2613.*duplicate-text-of-exclusion\.md/, `${file}:${i + 1} missing annotation`);
  });
}

test('no other audit script skips on bare duplicateTextOf unreviewed', () => {
  const dir = path.join(root, 'scripts');
  const reviewed = new Set(Object.keys(EXPECTED).concat(['audit-review-contamination.js']));
  const extra = fs.readdirSync(dir).filter((f) => /^audit-.*\.js$/.test(f) && !reviewed.has(f))
    .filter((f) => /duplicateTextOf[^\n]*\bcontinue;/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(extra, [], `review these per ${DOC}: ${extra}`);
});
