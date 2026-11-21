// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7999 (ship-check P1): safeWriteReview builds its own copy and can stamp wrongProduction /
// wrongShow on it (review-write-guard.js date guard, BRO-4383 wrong-article screen). heldOutRule
// first classified the writer's pre-guard object, so a review the guard just held out read as
// live. A real write must classify what landed on disk. Own process: the guard export is wrapped
// before the writer destructures it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../../scripts/lib/review-write-guard');
const realWrite = guard.safeWriteReview;
let stamp = false;
guard.safeWriteReview = (fp, data, opts) => realWrite(fp, stamp ? { ...data, wrongShow: true, wrongShowReason: 'guard stamp (test)' } : data, opts);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const showId = 'held-out-after-guard-fixture';
const fullText = 'The revival opens with a jolt and never lets up; the cast sings beautifully and the staging is sharp. '.repeat(30);
const input = {
  outletId: 'variety', outlet: 'Variety', criticName: 'Naveen Kumar',
  url: 'https://variety.com/legit/reviews/held-out-after-guard-fixture', source: 'held-out-after-guard-test',
  fields: { fullText, publishDate: '2024-04-01' },
};

function run(t, { guardStamps, dryRun = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-out-after-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  stamp = guardStamps;
  try { return createOrMergeReviewFile(showId, input, { reviewTextsDir: dir, dryRun }); } finally { stamp = false; }
}

test('a new review the write guard flags on its way to disk is labelled held out', (t) => {
  const r = run(t, { guardStamps: true });
  assert.equal(r.action, 'new');
  assert.equal(JSON.parse(fs.readFileSync(r.filepath, 'utf8')).wrongShow, true, 'sanity: the guard stamp landed');
  assert.equal(r.heldOutRule, 'wrongShow');
});

test('the same review without the stamp is not labelled', (t) => {
  const r = run(t, { guardStamps: false });
  assert.equal(r.action, 'new');
  assert.equal(Object.hasOwn(r, 'heldOutRule'), false);
});
