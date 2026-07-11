/**
 * Same-domain outlet refinement in createOrMergeReviewFile (card 38b637c5).
 *
 * When two registry outlets share a bare primary domain (telegraph /
 * sunday-telegraph), the URL carries no edition signal — the supplied outlet
 * name must stand. URL only overrides same-domain names when the PATH informed
 * the resolution (timeout.com/london). Cross-domain misattribution correction
 * is unchanged. Runs via the scripts/lib/*.test.mjs CI glob; dryRun only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};

const call = (outlet, critic, url) => quiet(() => createOrMergeReviewFile(
  'grace-pervades-west-end-2026',
  { outlet, criticName: critic, url, source: 'test', fields: { showScoreExcerpt: 'x' } },
  { dryRun: true }
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
