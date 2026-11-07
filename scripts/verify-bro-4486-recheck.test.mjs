/**
 * verify-bro-4486-recheck.test.mjs — RECHECK-AFTER acceptance for BRO-4486
 * (published star ratings ignored by scoring; NYT Degenerates scored on a
 * paywall copy). Asserts against LIVE review files, not fixtures: it is run
 * by scripts/autonomous-acceptance-recheck.js after the daily enrich +
 * scoring crons have had a chance to act. A red run means the pipeline did
 * not pick the fixes up, not a code regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXTS = path.join(HERE, '..', 'data', 'review-texts');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(TEXTS, rel), 'utf8'));
// land.js runs every changed *.test.mjs, so the cron-dependent checks skip
// until the first scoring run after landing (llm-ensemble-score 04:30 UTC).
const NO_TEXTS = fs.existsSync(path.join(TEXTS, 'degenerates-off-broadway-2026')) ? false : 'no review-texts checkout here';
const PENDING = NO_TEXTS || Date.now() < Date.parse('2026-10-02T06:00:00Z')
  ? 'waits for the 2026-10-02 enrich + scoring crons' : false;

test('NYT Degenerates was rescored on its complete text', { skip: PENDING }, () => {
  const d = read('degenerates-off-broadway-2026/nytimes--helen-shaw.json');
  assert.notEqual(d.llmMetadata?.textSource?.status, 'truncated',
    `still scored on the paywall copy (scoredAt ${d.llmMetadata?.scoredAt})`);
});

test('NYSR stars recovered from the page are anchored', { skip: PENDING }, () => {
  for (const rel of [
    'making-a-show-of-myself-off-broadway-2026/nysr--michael-sommers.json',
    'how-shakespeare-saved-my-life-off-broadway-2026/nysr--frank-scheck.json',
  ]) {
    const d = read(rel);
    assert.equal(d.originalScore, '3/5 stars', `${rel}: rating missing`);
    assert.ok(d.llmScore?.band, `${rel}: not re-scored in anchored mode yet`);
    assert.ok(d.assignedScore >= 51 && d.assignedScore <= 70, `${rel}: ${d.assignedScore} outside the 3-star band`);
  }
});

test('Culture Sauce star printed in the text is stored and anchored', { skip: PENDING }, () => {
  const d = read('the-cherry-orchard-park-avenue-armory-off-broadway-2026/culturesauce--unknown.json');
  assert.equal(d.originalScore, '5/5 stars');
  assert.ok(d.llmScore?.band, 'not re-scored in anchored mode yet');
  assert.ok(d.assignedScore >= 91, `5-star review shipped at ${d.assignedScore}`);
});

test('hand corrections still hold', { skip: NO_TEXTS }, () => {
  assert.equal(read('monte-cristo-the-york-theatre-company-off-broadway-2026/nysr--david-finkle.json').humanReviewScore, 70);
  assert.equal(read('care-west-end-2026/financialtimes--tim-bano.json').humanReviewScore, 70);
  assert.equal(read('what-we-did-before-our-moth-days-off-broadway-2026/culturesauce--thom-geier.json').humanReviewScore, 50);
});
