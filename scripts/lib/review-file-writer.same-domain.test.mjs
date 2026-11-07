/**
 * Same-domain outlet refinement in createOrMergeReviewFile (card 38b637c5).
 *
 * When two registry outlets share a bare primary domain (telegraph /
 * sunday-telegraph), the URL carries no edition signal — the supplied outlet
 * name must stand. URL only overrides same-domain names when the PATH informed
 * the resolution (timeout.com/london). Cross-domain misattribution correction
 * is unchanged. Runs via the scripts/lib/*.test.mjs CI glob; dryRun only.
 *
 * BRO-4125 (same root cause as review-file-writer-named-non-review.test.mjs):
 * reviewTextsDir is pinned to a throwaway temp dir, NOT the real
 * data/review-texts corpus. grace-pervades-west-end-2026 is a real, closed
 * West End show (ran 2026-04-30 to 2026-07-11) — its real Sunday
 * Telegraph/Tim Walker, Time Out/Andrzej Lukowski, and Guardian/Susannah
 * Clapp reviews are long since collected in the live corpus, so every
 * assertion here (`r.action === 'new'`) is one CI checkout away from
 * findExistingReviewFile matching a real file and forking into the merge
 * path instead. dryRun:true means nothing is ever written to this temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-writer-same-domain-'));

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};

const call = (outlet, critic, url) => quiet(() => createOrMergeReviewFile(
  'grace-pervades-west-end-2026',
  { outlet, criticName: critic, url, source: 'test', fields: { showScoreExcerpt: 'x' } },
  { dryRun: true, reviewTextsDir }
));

test('Sunday Telegraph label + bare telegraph.co.uk URL stays sunday-telegraph', () => {
  const r = call('Sunday Telegraph', 'Tim Walker',
    'https://www.telegraph.co.uk/theatre/what-to-see/some-sunday-review/');
  assert.equal(r.action, 'new');
  assert.match(r.filepath, /sunday-telegraph--tim-walker\.json$/);
});

test('timeout path split still authoritative: NY label + /london URL → timeout-london', () => {
  const r = call('Time Out New York', 'Andrzej Lukowski',
    'https://www.timeout.com/london/theatre/some-review');
  assert.equal(r.action, 'new');
  assert.match(r.filepath, /timeout-london--andrzej-lukowski\.json$/);
});

test('cross-domain misattribution still corrected by URL domain', () => {
  const r = call('Observer', 'Susannah Clapp',
    'https://www.theguardian.com/stage/2026/jun/01/some-observer-review');
  assert.equal(r.action, 'new');
  assert.match(r.filepath, /guardian--susannah-clapp\.json$/);
});
