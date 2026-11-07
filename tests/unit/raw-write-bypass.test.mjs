// BRO-2710: wrongProduction --fix paths must write review files through
// safeWriteReview, not a raw fs.writeFileSync that skips every write guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const FILES = ['audit-wrong-production.js', 'unflag-wrong-production-fps.js'];
// Non-review outputs (the audit report) may still be written raw.
const ALLOWED_RAW_TARGETS = new Set(['reportPath']);

for (const file of FILES) {
  const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');

  test(`${file} imports and calls safeWriteReview`, () => {
    assert.match(src, /\{[^}]*\bsafeWriteReview\b[^}]*\}\s*=\s*require\(['"]\.\/lib\/review-write-guard['"]\)/);
    assert.match(src.replace(/\/\/.*$/gm, ''), /safeWriteReview\(/);
  });

  test(`${file} has no raw fs.writeFileSync of a review file`, () => {
    const raw = [...src.matchAll(/(?:fs\.)?(?:promises\.)?(?:writeFileSync|writeFile|appendFileSync|renameSync)\(\s*([^,]+),/g)]
      .map((m) => m[1].trim())
      .filter((target) => !ALLOWED_RAW_TARGETS.has(target));
    assert.deepEqual(raw, []);
  });
}
