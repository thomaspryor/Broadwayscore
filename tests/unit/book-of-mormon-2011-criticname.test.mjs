import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const showId = 'book-of-mormon-2011';
const target = 'guardian--ben-brantley.json';
// The published byline is Hadley Freeman. Brantley is mentioned in the body.
// https://www.theguardian.com/stage/2011/mar/31/book-of-mormon-review
// The legacy filename is an identifier, not evidence of authorship.
const action = {
  file: `${showId}/${target}`, field: 'criticName',
  oldValue: 'Ben Brantley', newValue: 'Hadley Freeman',
};

test('BRO-4163 corrects the Guardian byline through the real writer without changing scores or siblings', (t) => {
  const dir = fs.mkdtempSync(path.join(root, '.bro-4163-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, showId));
  // Metadata-only fixtures reproduce the original attribution without private text.
  const records = {
    [target]: { showId, outletId: 'guardian', criticName: 'Ben Brantley', assignedScore: 96, originalScore: '5/5 stars' },
    'guardian--david-cote.json': { showId, outletId: 'guardian', criticName: 'David Cote', assignedScore: 93 },
    'nytimes--ben-brantley.json': { showId, outletId: 'nytimes', criticName: 'Ben Brantley', assignedScore: 93 },
  };
  for (const [file, record] of Object.entries(records)) {
    fs.writeFileSync(path.join(dir, showId, file), JSON.stringify(record));
  }
  const stamp = { fixId: 'bro-4163', at: '2026-10-20T00:00:00.000Z' };
  const result = executeReviewFieldEditIn(dir, action, stamp);
  assert.equal(result.ok, true, result.reason);
  for (const [file, record] of Object.entries(records)) {
    const after = JSON.parse(fs.readFileSync(path.join(dir, showId, file), 'utf8'));
    assert.deepEqual(after, file === target ? {
      ...record, criticName: 'Hadley Freeman',
      approvedFixes: [{ ...stamp, field: 'criticName', newValue: 'Hadley Freeman' }],
    } : record, file);
  }
  assert.equal(executeReviewFieldEditIn(dir, action, stamp).ok, false,
    'the stale correction must refuse an already corrected record');
});

test('BRO-4163 private corpus retains the verified Guardian byline and distinct sibling authors', (t) => {
  const dir = path.join(root, 'data', 'review-texts', showId);
  if (!fs.existsSync(dir)) {
    t.skip('private review-texts corpus is not mounted; the writer regression above runs offline');
    return;
  }
  for (const [file, criticName] of [
    [target, 'Hadley Freeman'],
    ['guardian--david-cote.json', 'David Cote'],
    ['nytimes--ben-brantley.json', 'Ben Brantley'],
  ]) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(record.criticName, criticName, file);
  }
});
