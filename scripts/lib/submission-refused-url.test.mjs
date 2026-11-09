// BRO-7210: the submit-review-form refusal is honoured on the read side
// (explainExclusion), with the human escape hatches, and mirrored in the rebuild loop
// and scoring-delta's replay (rebuild decides inclusion with inline copies).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const guards = require('./review-guards.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, '..');

const base = {
  source: 'submit-review-form',
  outlet: 'Letterboxd',
  criticName: 'Pat Example',
  fullText: 'A long enough body of review text. '.repeat(40),
  publishDate: '2025-06-01',
};
const refused = { ...base, url: 'https://letterboxd.com/someone/film/some-film/' };

test('submit-review-form record on a URL the form refuses is excluded', () => {
  assert.equal(guards.isRefusedSubmissionUrlRecord(refused), true);
  assert.equal(guards.isIncludableForRebuild(refused, {}, '/x/s/letterboxd--pat.json'), false);
  assert.equal(guards.explainExclusion(refused, {}, '/x/s/letterboxd--pat.json'), 'submissionRefusedUrl');
});

test('human escape hatches and other sources are not caught', () => {
  assert.equal(guards.isRefusedSubmissionUrlRecord({ ...refused, allowNonReviewUrl: true }), false);
  assert.equal(guards.isRefusedSubmissionUrlRecord({ ...refused, namedNonReviewUrlManualClear: true }), false);
  assert.equal(guards.isRefusedSubmissionUrlRecord({ ...refused, source: 'rss-discovery' }), false);
  assert.equal(guards.isRefusedSubmissionUrlRecord({ ...base, url: 'https://www.nytimes.com/2025/06/01/theater/a-show-review.html' }), false);
});

test('submissionRefusedUrl is mirrored in rebuild-all-reviews.js and scoring-delta.js', () => {
  for (const f of ['rebuild-all-reviews.js', 'scoring-delta.js']) {
    const s = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    assert.match(s, /isRefusedSubmissionUrlRecord\(/, `${f} must call isRefusedSubmissionUrlRecord`);
  }
});
