import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countWrongProductionFiles, formatWrongProductionRatio } = require('./show-score-url-wrongproduction-ratio.js');

function fixture(t, reviews = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongproduction-ratio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'show');
  fs.mkdirSync(dir);
  reviews.forEach((review, index) => fs.writeFileSync(path.join(dir, `${index}.json`), JSON.stringify(review)));
  return { root, dir };
}

test('counts top-level and nested boolean flags once per JSON file', t => {
  const { root, dir } = fixture(t, [
    { wrongProduction: true },
    { contentVerification: { wrongProduction: true } },
    { wrongProduction: true, contentVerification: { wrongProduction: true } },
    { wrongProduction: false, contentVerification: { wrongProduction: true } },
    { wrongProduction: true, contentVerification: { wrongProduction: false } },
    { wrongProduction: false },
    {},
    { wrongProduction: 'true', contentVerification: { wrongProduction: 1 } },
    null,
  ]);
  fs.writeFileSync(path.join(dir, 'notes.txt'), '{"wrongProduction":true}');
  fs.mkdirSync(path.join(dir, 'nested.json'));
  fs.writeFileSync(path.join(dir, 'nested.json', 'review.json'), '{"wrongProduction":true}');
  assert.deepEqual(countWrongProductionFiles(root, 'show'), {
    totalFiles: 9, wrongProductionFiles: 5, unreadableFiles: 0, unavailable: false,
  });
  assert.equal(formatWrongProductionRatio(countWrongProductionFiles(root, 'show')),
    'wrongProduction: 5/9 files (55.6%)');
});

test('distinguishes no flags, an empty directory, and unavailable review texts', t => {
  const { root, dir } = fixture(t, [{ wrongProduction: false }, {}]);
  assert.equal(formatWrongProductionRatio(countWrongProductionFiles(root, 'show')),
    'wrongProduction: 0/2 files (0.0%)');
  fs.mkdirSync(path.join(root, 'empty'));
  assert.equal(formatWrongProductionRatio(countWrongProductionFiles(root, 'empty')),
    'wrongProduction: 0/0 files (n/a)');
  assert.equal(formatWrongProductionRatio(countWrongProductionFiles(root, 'missing')),
    'wrongProduction: n/a (review-texts unavailable)');
  assert.equal(formatWrongProductionRatio(countWrongProductionFiles(path.join(root, 'absent-corpus'), 'show')),
    'wrongProduction: n/a (review-texts unavailable)');
  fs.writeFileSync(path.join(dir, 'not-a-directory'), '');
  assert.equal(countWrongProductionFiles(dir, 'not-a-directory').unavailable, true);
});

test('discloses malformed and unreadable JSON without aborting the report', t => {
  const { root, dir } = fixture(t, [{ wrongProduction: true }, {}]);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  fs.writeFileSync(path.join(dir, 'unreadable.json'), '{}');
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (filename, ...args) {
    if (filename === path.join(dir, 'unreadable.json')) throw new Error('EACCES');
    return readFileSync.call(this, filename, ...args);
  });
  const counts = countWrongProductionFiles(root, 'show');
  assert.deepEqual(counts, { totalFiles: 4, wrongProductionFiles: 1, unreadableFiles: 2, unavailable: false });
  assert.equal(formatWrongProductionRatio(counts), 'wrongProduction: 1/4 files (25.0%; 2 unreadable)');
});

test('does not modify review files while counting', t => {
  const { root, dir } = fixture(t, [{ wrongProduction: true }]);
  const filename = path.join(dir, '0.json');
  const before = fs.readFileSync(filename, 'utf8');
  const mtime = fs.statSync(filename).mtimeMs;
  assert.equal(countWrongProductionFiles(root, 'show').wrongProductionFiles, 1);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(fs.statSync(filename).mtimeMs, mtime);
});
