// BRO-5899: a review file created by manual ingest or by the audit-aggregator-gap
// auto-ingest path lands with no llmScore. The scorer has no queue file: it scans
// the review-texts tree for files lacking llmScore (scripts/llm-scoring/index.ts
// unscoredOnly, mirrored by scripts/lib/scoring-queue-counts.js). This test pins
// that contract with the real writer and the real counter predicate, so a future
// change that makes an ingested file invisible to the scorer fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer');
const { buildManualReviewFields } = require('./manual-review-fields');
const { loadShowsById, unscoredSkipReason, isActionableUnscored } = require('./scoring-queue-counts');

const shows = loadShowsById();
const SHOW_ID = 'paranormal-activity-2026';
const show = shows.get(SHOW_ID);
// Under CI the core data is checked out, so a missing show is a real failure, not a skip.
if (!show && process.env.CI) throw new Error('data/shows.json has no paranormal-activity-2026 in CI');
const skip = show ? false : 'data/shows.json has no paranormal-activity-2026 (stub or stale core data)';

const BODY = (
  'Paranormal Activity arrives on Broadway with a lot of noise and some real scares. ' +
  'The staging is inventive and the cast commits fully to the premise, though the second act sags. '
).repeat(8);

function ingest({ operatorTrust, source }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5899-'));
  try {
    const fields = buildManualReviewFields({ fullText: BODY, operatorTrust, publishDate: '2026-08-25' });
    const res = createOrMergeReviewFile(SHOW_ID, {
      outlet: 'vulture',
      criticName: 'Test Critic',
      url: 'https://www.vulture.com/article/paranormal-activity-review.html',
      source,
      fields,
    }, { reviewTextsDir: dir });
    assert.equal(res.action, 'new', `writer refused the file: ${JSON.stringify(res)}`);
    const data = JSON.parse(fs.readFileSync(res.filepath, 'utf8'));
    assert.equal(data.showId, SHOW_ID, 'the scorer resolves the show from the file showId');
    return { data, ctx: { show, showTitle: show.title, filePath: res.filepath } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, opts] of [
  ['operator manual ingest (ingest-manual-review.js, text only)', { operatorTrust: true, source: 'manual-ingest' }],
  ['automated URL ingest (audit-aggregator-gap -> ingest-review-from-url)', { operatorTrust: false, source: 'audit-aggregator-gap' }],
]) {
  test(`${label}: lands unscored and the scorer selects it`, { skip }, () => {
    const { data, ctx } = ingest(opts);
    assert.equal(data.llmScore, undefined, 'ingest must not fabricate an llmScore');
    assert.equal(unscoredSkipReason(data, ctx), null, 'an ingested, scoreable file must be actionable unscored work');
    assert.equal(isActionableUnscored(data, ctx), true);
  });
}

test('a file that already carries an llmScore is not re-queued', { skip }, () => {
  const { data, ctx } = ingest({ operatorTrust: true, source: 'manual-ingest' });
  data.llmScore = { score: 70 };
  assert.equal(unscoredSkipReason(data, ctx), 'already_scored');
});
