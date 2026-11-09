// BRO-6983 prevention: a script that SETS a review record's publishDate and writes
// the file with a bare fs.writeFileSync skips safeWriteReview's cross-market
// (class A) check. That is how a sibling production's review reached
// maybe-happy-ending-2024 live (collector -> persistReviewSnapshot) and re-reddened
// the zero-tolerance audit three times. Every such script must go through a guarded
// writer or call flagSiblingEraDateOnPersist before it writes.
//
// The heuristic is deliberately narrow (review-texts script + `<rec>.publishDate =`
// + writeFileSync of a file path), so a new raw date writer fails here.
// EXEMPT may only shrink. Each entry needs a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED = /safeWriteReview|writeReviewOrThrow|persistReviewSnapshot|createOrMergeReviewFile|flagSiblingEraDateOnPersist/;
const SETS_DATE = /\b(data|review|d|r|json|rec|record|existing)\.publishDate\s*=[^=]/;
const TOUCHES_CORPUS = /review-texts|REVIEW_DIR|REVIEW_TEXTS/;
const RAW_WRITE = /writeFileSync\((filePath|file|fp|reviewPath|candidate\.filePath|full)\b/;

const EXEMPT = {
  'fix-utc-shifted-publish-dates.js': 'shifts a stored date by one timezone day; cannot move a review between productions',
};

test('every script that sets a review publishDate and raw-writes it is guarded', () => {
  const offenders = [];
  for (const f of fs.readdirSync(SCRIPTS).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    if (SETS_DATE.test(src) && TOUCHES_CORPUS.test(src) && RAW_WRITE.test(src) && !GUARDED.test(src) && !EXEMPT[f]) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `raw publishDate writers need flagSiblingEraDateOnPersist (or a guarded writer): ${offenders.join(', ')}`);
});

test('EXEMPT entries stay honest (still exist and still unguarded)', () => {
  for (const f of Object.keys(EXEMPT)) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    assert.ok(!GUARDED.test(src), `${f} is now guarded: delete its exemption`);
  }
});
