// BRO-7174: the scheduled dedupe/recovery writers keep a duplicateOf / wrongShow
// value an approved-fix plan set. Every assertion runs the REAL writer decision
// (fix-circular-duplicate-pairs audit()+fix(), verify-existing-reviews'
// recoverCandidate, the url-mismatch audit's isDuplicateOfUrlMismatch /
// clearDuplicateMismatch, and safeWriteReview's stale-pointer self-heal) on
// temp fixtures, so reverting the shared guard turns these red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-7174-'));
process.env.REVIEW_TEXTS_DIR = ROOT; // read at fix-circular-duplicate-pairs load
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const { approvedFixBinding } = require('../../scripts/lib/approved-fix-flag');
const circular = require('../../scripts/fix-circular-duplicate-pairs');
const { recoverCandidate } = require('../../scripts/lib/verify-recover-candidate');
const { isDuplicateOfUrlMismatch, clearDuplicateMismatch } = require('../../scripts/lib/duplicate-of-url-mismatch');
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');

const body = 'A substantive theatre review of the production in question. '.repeat(40);

function approve(record, field, newValue) {
  record.approvedFixes = [...(record.approvedFixes || []),
    { fixId: 'test-fix', field, newValue, at: '2026-10-12T12:10:17.926Z', boundTo: approvedFixBinding(record) }];
  return record;
}
const review = (critic, extra = {}) => ({
  showId: 'pair-show-2026', outlet: 'The New York Times', outletId: 'nytimes', criticName: critic,
  url: 'https://www.nytimes.com/2026/01/01/theater/pair-show-review.html', fullText: body, ...extra,
});
function writeShow(showId, files) {
  const dir = path.join(ROOT, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...data, showId }, null, 2) + '\n');
  return (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

test('fix-circular-duplicate-pairs keeps an approved pointer in a mutual pair and still repairs an unapproved one', () => {
  const A = 'nytimes--ben-brantley.json', B = 'nytimes--laura-collins-hughes.json';
  const readHeld = writeShow('held-pair-2019', {
    [A]: approve(review('Ben Brantley', { duplicateOf: B }), 'duplicateOf', B),
    [B]: review('Laura Collins-Hughes', { duplicateOf: A }),
  });
  const readOpen = writeShow('open-pair-2019', {
    [A]: review('Ben Brantley', { duplicateOf: B }),
    [B]: review('Laura Collins-Hughes', { duplicateOf: A }),
  });
  const pairs = circular.audit();
  const open = pairs.find((p) => p.showId === 'open-pair-2019');
  assert.ok(open, 'control: the unapproved mutual pair is reported');
  const held = pairs.find((p) => p.showId === 'held-pair-2019');
  // Either the held pair is skipped, or the repair it plans keeps A -> B.
  if (held) assert.equal(held.canonical, B, 'a planned repair may only clear the unapproved side');
  // fix() re-reads disk and rechecks, even when handed a pair the audit skipped.
  circular.fix([...pairs, { showId: 'held-pair-2019', canonical: A, loser: B, reason: 'stale finding' }]);
  assert.equal(readHeld(A).duplicateOf, B, 'approved duplicateOf survives the circular-pair writer');
  assert.equal([readOpen(A).duplicateOf, readOpen(B).duplicateOf].filter(Boolean).length, 1, 'control pair repaired');
});

for (const field of ['wrongShow', 'wrongProduction']) {
  test(`verify-existing-reviews RECOVER skips an approved ${field}, re-evaluates once the content changes`, () => {
    const r = approve(review('Jane Critic', { [field]: true }), field, true);
    assert.equal(recoverCandidate(r), null);
    assert.equal(recoverCandidate({ ...r, approvedFixes: undefined })?.textSource, 'fullText', 'control: unapproved flag is a candidate');
    r.fullText += ' A different article landed on this file.';
    assert.equal(recoverCandidate(r)?.textSource, 'fullText', 'approval about older content no longer binds');
  });
}

test('url-mismatch audit and the write-guard self-heal keep an approved cross-url duplicateOf', () => {
  const primary = review('Laura Collins-Hughes', { url: 'https://www.nytimes.com/2026/01/02/theater/other-angle.html' });
  const loser = approve(review('Ben Brantley', { duplicateOf: 'nytimes--laura-collins-hughes.json', duplicateReason: 'approved' }),
    'duplicateOf', 'nytimes--laura-collins-hughes.json');
  const read = writeShow('url-pair-2026', { 'nytimes--laura-collins-hughes.json': primary, 'nytimes--ben-brantley.json': loser });
  const file = path.join(ROOT, 'url-pair-2026', 'nytimes--ben-brantley.json');

  assert.equal(isDuplicateOfUrlMismatch(loser, primary), false, 'approved pointer is not reported as a mismatch');
  assert.equal(isDuplicateOfUrlMismatch({ ...loser, approvedFixes: [] }, primary), true, 'control: unapproved pointer is');
  assert.equal(clearDuplicateMismatch(file, { ...loser }, {
    reason: 'url-mismatch', duplicateOf: loser.duplicateOf, siblingUrl: primary.url,
  }), false, '--fix refuses a stale finding against an approved pointer');
  assert.equal(read('nytimes--ben-brantley.json').duplicateOf, 'nytimes--laura-collins-hughes.json');

  safeWriteReview(file, { ...read('nytimes--ben-brantley.json'), textStatus: 'touched' });
  assert.equal(read('nytimes--ben-brantley.json').duplicateOf, 'nytimes--laura-collins-hughes.json',
    'an unrelated write keeps the approved pointer');
});

test('an approval that set a different value, or cleared the field, protects nothing', () => {
  const { holdsApprovedValue } = require('../../scripts/lib/approved-fix-writer-guards');
  const r = approve(review('Ben Brantley', { duplicateOf: 'other.json' }), 'duplicateOf', 'target.json');
  assert.equal(holdsApprovedValue(r, 'duplicateOf'), false);
  assert.equal(holdsApprovedValue(approve(review('X', { duplicateOf: null }), 'duplicateOf', null), 'duplicateOf'), false);
  assert.equal(holdsApprovedValue(approve(review('X', { duplicateOf: 't.json' }), 'duplicateOf', 't.json'), 'duplicateOf'), true);
  // legacy stamps (no boundTo, the sea-wall 2026-10-12 shape) still bind
  assert.equal(holdsApprovedValue({ duplicateOf: 't.json', approvedFixes: [{ field: 'duplicateOf', newValue: 't.json' }] }, 'duplicateOf'), true);
});
