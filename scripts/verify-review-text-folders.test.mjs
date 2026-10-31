// BRO-5153: the five review-text folders that once had no shows.json entry must
// stay resolved (id in shows.json, or folder gone). Where a review-texts corpus
// is available, also assert none of them is an orphan folder.
// REQUIRE_REVIEW_CORPUS=1 makes a missing checkout fail instead of skipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const { findOrphanReviewFolders } = require('./lib/orphan-review-folders');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const showsPath = path.join(root, 'data/shows.json');
const haveShows = fs.existsSync(showsPath);
const shows = haveShows ? (JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows || []) : [];
const ids = new Set(shows.map((s) => s.id));
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

const FOLDERS = [
  'robin-hood-west-end-2024',
  'the-tempest-west-end-2024',
  'all-male-as-you-like-it-regional-2026',
  'can-i-be-frank-off-broadway-2026',
  'queen-of-versailles',
];
// An explicit override must not fall back to a different, usable checkout.
const corpus = (process.env.REVIEW_TEXTS_DIR ? [process.env.REVIEW_TEXTS_DIR] : [
  resolveReviewTextsDir(),
  path.join(root, 'data/review-texts'),
  path.join(os.homedir(), 'broadway-review-texts'),
  path.join(root, '..', 'broadway-review-texts'), // sibling of the checkout
  path.join(root, '../../../..', 'broadway-review-texts'), // sibling of the main checkout, from a .claude/worktrees/<name>
])
  .filter(Boolean).find((d) => fs.existsSync(d) && fs.readdirSync(d).length > 1000);
const skipData = !haveShows && 'no data/shows.json';
const skipCorpus = !corpus && REQUIRE_CORPUS ? false : skipData || (!corpus && 'no review-texts corpus');
const missingCorpusMessage = 'REQUIRE_REVIEW_CORPUS=1 but no usable review-texts corpus (>1000 entries expected): the review-texts checkout did not land. Fix the checkout rather than unsetting the flag.';

test('BRO-5153 folders are not orphans', { skip: skipCorpus }, () => {
  if (!corpus) assert.fail(missingCorpusMessage);
  assert.ok(shows.length >= 500);
  const orphans = new Set(findOrphanReviewFolders(corpus, ids).map((o) => o.folder));
  for (const f of FOLDERS) assert.ok(!orphans.has(f), `${f} is an orphan review-text folder`);
});

test('BRO-5153 ids that kept folders are in shows.json', { skip: skipData }, () => {
  for (const f of FOLDERS.slice(0, 3)) assert.ok(ids.has(f), `${f} missing from shows.json`);
});

test('BRO-5153 folders without a show id stay deleted', { skip: skipCorpus }, () => {
  if (!corpus) assert.fail(missingCorpusMessage);
  for (const f of FOLDERS.filter((x) => !ids.has(x))) {
    assert.ok(!fs.existsSync(path.join(corpus, f)), `${f} reappeared with no shows.json entry`);
  }
});
