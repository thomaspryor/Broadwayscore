import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findRawReviewWrites, scanReviewWriters, unapprovedWrites } = require('./review-write-safety');
const baseline = require('./review-write-safety-baseline.json');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Advisory-first rollout (CLAUDE.md section 19): the JSON baseline documents
// exact pre-existing calls outside BRO-5157, the guarded persistence modules,
// and conservatively detected non-review archives, ledgers and reports. These
// are exceptions, not file-wide permissions. A changed or additional call
// needs migration; deleting an old call needs no baseline update. The 22
// migrated scripts and the shared browser helper have no raw review writes.
// Existing test.yml scripts/lib/*.test.mjs and land's scripts-lib-tests glob
// run this test without a new workflow step or a hand-maintained manifest.
test('no new raw writes to review-text files outside documented exceptions', () => {
  const unexpected = unapprovedWrites(scanReviewWriters(root), baseline);
  assert.deepEqual(unexpected, [], unexpected.map(h => `${h.file}:${h.line}: ${h.target}`).join('\n'));
});

test('detects member paths, aliases, temp files and indirect review directories', () => {
  for (const target of ['r.filePath', 'review.path', 'entry.file', 'filePath', "r.file + '.tmp'"]) {
    assert.equal(findRawReviewWrites(`fs.writeFileSync(${target}, JSON.stringify(data));`).length, 1, target);
  }
  const source = `
    const { writeFileSync: save } = require('node:fs');
    const store = path.join(__dirname, 'data', 'review-texts');
    const destination = path.join(store, show, name);
    save(destination, JSON.stringify(data));
    fs['writeFileSync'](destination, payload);
    fs.promises.writeFile(destination, payload);
  `;
  assert.equal(findRawReviewWrites(source).length, 3);
});

test('ignores comments, guarded calls and unrelated report destinations', () => {
  assert.deepEqual(findRawReviewWrites(`
    // fs.writeFileSync(review.filePath, JSON.stringify(data));
    const example = 'fs.writeFileSync(review.filePath, data)';
    persistReviewSnapshot(review);
    safeWriteReview(review.filePath, data);
    fs.writeFileSync(reportPath, JSON.stringify(report));
  `), []);
});

test('detects assigned writer aliases and alias chains', () => {
  assert.equal(findRawReviewWrites(`
    const save = fs.writeFileSync;
    save(review.filePath, JSON.stringify(data));
    const chained = save;
    chained(review.filePath, JSON.stringify(data));
    let later;
    later = fs['writeFileSync'];
    later(review.filePath, JSON.stringify(data));
    const asynchronous = fs.promises.writeFile;
    asynchronous(review.filePath, JSON.stringify(data));
  `).length, 4);
});

test('baseline permits only the exact call and multiplicity in the same file', () => {
  const [call] = findRawReviewWrites('fs.writeFileSync(review.filePath, JSON.stringify(data));');
  const row = { file: 'scripts/legacy.js', ...call };
  assert.deepEqual(unapprovedWrites([row], [row]), []);
  assert.equal(unapprovedWrites([row, row], [row]).length, 1);
  assert.equal(unapprovedWrites([{ ...row, file: 'scripts/new.js' }], [row]).length, 1);
  const [edited] = findRawReviewWrites('fs.writeFileSync(review.filePath, JSON.stringify(stale));');
  assert.equal(unapprovedWrites([{ ...row, ...edited }], [row]).length, 1);
});
