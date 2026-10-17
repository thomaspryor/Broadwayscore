/**
 * BRO-2618: which Telegraph capture scores the Globe Midsummer.
 *
 * Decision (both captures read in full 2026-10-13): Dominic Cavendish's real
 * Telegraph review is the direct telegraph.co.uk capture (3/5, "Shakespeare's
 * Globe, London SE1, until Aug 29"), misfiled under the Regent's Park show.
 * The Globe file held a westendtheatre.com round-up digest. The plan keeps the
 * Globe file, repoints it at the Telegraph url with the right byline and a 3/5
 * band score, and deletes the misfiled duplicate. This pins that plan and
 * checks every field edit passes the real executor's allowlist.
 *
 * Run: node --test tests/unit/globe-midsummer-telegraph-capture-decision.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const plan = require('../../data/pending-fixes/bro-2618.json');
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');

const GLOBE = 'a-midsummer-nights-dream-globe-west-end-2026';
const GLOBE_FILE = `${GLOBE}/telegraph--dominic-cavendish.json`;
const TELEGRAPH_URL = 'https://www.telegraph.co.uk/theatre/what-to-see/midsummer-nights-dream-review-shakespeares-globe/';
const actions = plan.plan.actions;

test('the misfiled Regent\'s Park copy is deleted, before the Globe file takes its url', () => {
  const del = actions.findIndex((a) => a.type === 'review-file-op' && a.operation === 'delete'
    && a.sourcePath === 'a-midsummer-nights-dream-west-end-2026/telegraph--dominic-cavendish.json');
  const url = actions.findIndex((a) => a.file === GLOBE_FILE && a.field === 'url');
  assert.ok(del !== -1, 'delete action present');
  assert.ok(url !== -1 && del < url, 'delete runs first');
});

test('the Globe file keeps the Telegraph review: direct url, Cavendish byline, 3/5-band score', () => {
  const edit = (field) => actions.find((a) => a.file === GLOBE_FILE && a.field === field);
  assert.equal(edit('url').newValue, TELEGRAPH_URL);
  assert.equal(edit('criticName').newValue, 'Dominic Cavendish');
  const score = edit('humanReviewScore').newValue;
  assert.ok(score >= 51 && score <= 70, `3/5 maps to 51-70, got ${score}`);
});

test('every field edit passes the executor allowlist on a record shaped like the Globe file', () => {
  let rec = {
    showId: GLOBE, outletId: 'telegraph', outlet: 'The Telegraph', criticName: 'Julianna Barnaby',
    url: 'https://www.westendtheatre.com/352874/news/reviews/a-midsummer-nights-dream-globe-reviews/',
    isRoundupArticle: true, fullText: 'round-up digest',
  };
  for (const a of actions.filter((x) => x.type === 'review-field-edit')) {
    assert.deepEqual(rec[a.field] ?? null, a.oldValue, `${a.field} oldValue matches the record`);
    const r = applyReviewFieldEdit(rec, a, { at: '2026-10-13', by: 'bro-2618' }, { folder: GLOBE });
    assert.equal(r.ok, true, `${a.field}: ${r.reason || ''}`);
    rec = r.record;
  }
});
