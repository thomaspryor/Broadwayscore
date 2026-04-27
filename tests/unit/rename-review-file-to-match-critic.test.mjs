import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renameReviewFileToMatchCritic } = require('../../scripts/lib/review-normalization');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rename-helper-'));
}

describe('renameReviewFileToMatchCritic', () => {
  test('no-op when filename already matches criticName slug', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'variety--frank-rizzo.json');
    fs.writeFileSync(file, JSON.stringify({ outletId: 'variety', criticName: 'Frank Rizzo' }) + '\n');
    const r = renameReviewFileToMatchCritic(file, { outletId: 'variety', criticName: 'Frank Rizzo' });
    assert.strictEqual(r.action, 'noop');
    assert.strictEqual(r.newFilePath, file);
    assert.ok(fs.existsSync(file));
  });

  test('renames when destination does not exist', () => {
    const dir = tmpDir();
    const oldFile = path.join(dir, 'nytg--gillian-russo.json');
    const data = { outletId: 'nytg', criticName: 'Allison Considine', fullText: 'review text', assignedScore: 80 };
    fs.writeFileSync(oldFile, JSON.stringify(data) + '\n');
    const r = renameReviewFileToMatchCritic(oldFile, data);
    assert.strictEqual(r.action, 'rename');
    assert.strictEqual(path.basename(r.newFilePath), 'nytg--allison-considine.json');
    assert.ok(!fs.existsSync(oldFile));
    assert.ok(fs.existsSync(r.newFilePath));
  });

  // Regression for the cats-the-jellicle-ball-2026 / variety-Frank-Rizzo bug:
  // when the destination already exists (legitimate sibling file with the new
  // criticName slug), the helper must merge unique fields from the source and
  // delete the source — not leave both files on disk where validate-review-texts
  // will flag them as a duplicate.
  test('merges unique fields and deletes source when destination exists', () => {
    const dir = tmpDir();
    const oldFile = path.join(dir, 'variety--rebecca-rubin.json');
    const newFile = path.join(dir, 'variety--frank-rizzo.json');
    fs.writeFileSync(newFile, JSON.stringify({
      outletId: 'variety',
      criticName: 'Frank Rizzo',
      url: 'https://variety.com/cats-review',
      fullText: 'short',
    }) + '\n');
    const sourceData = {
      outletId: 'variety',
      criticName: 'Frank Rizzo',
      url: null,
      fullText: 'longer fuller review text',
      assignedScore: 88,
      contentTier: 'truncated',
    };
    fs.writeFileSync(oldFile, JSON.stringify(sourceData) + '\n');
    const r = renameReviewFileToMatchCritic(oldFile, sourceData);
    assert.strictEqual(r.action, 'merge');
    assert.strictEqual(r.newFilePath, newFile);
    assert.ok(!fs.existsSync(oldFile));
    const merged = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    assert.strictEqual(merged.assignedScore, 88, 'assignedScore should merge from source');
    assert.strictEqual(merged.contentTier, 'truncated', 'contentTier should merge from source');
    assert.strictEqual(merged.url, 'https://variety.com/cats-review', 'pre-existing url must NOT be overwritten');
    assert.strictEqual(merged.fullText, 'short', 'pre-existing fullText must NOT be overwritten');
  });

  test('handles outlet field fallback (data.outlet when outletId missing)', () => {
    const dir = tmpDir();
    const oldFile = path.join(dir, 'variety--old-name.json');
    const data = { outlet: 'Variety', criticName: 'New Name' };
    fs.writeFileSync(oldFile, JSON.stringify(data) + '\n');
    const r = renameReviewFileToMatchCritic(oldFile, data);
    assert.strictEqual(r.action, 'rename');
    assert.match(path.basename(r.newFilePath), /^variety--/);
  });
});
