/**
 * BRO-4956: a flagged record about another show or production held the
 * outlet+critic slot, and the real review of this production by the same
 * critic was lost. London Box Office's Stuart King reviewed Juniper Blood
 * (Donmar, 2025) and Blood of my Blood (Royal Court, 2026); the 2025 file sat
 * flagged in the Blood of my Blood folder, the dateless roundup discovery was
 * refused 6 times (gather-collisions.json), and a dated ingest hit "Stale
 * merge". Exercises the real predicate, collision detector and writer.
 *
 * Run: node --test tests/unit/flagged-slot-superseded.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { flaggedSlotSupersededBy } = require('../../scripts/lib/review-slot-guards.js');
const { detectIngestCollision } = require('../../scripts/lib/manual-review-fields.js');
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');

const BLOOD = {
  id: 'blood-of-my-blood-west-end-2026', title: 'Blood of my Blood', venue: 'Royal Court',
  category: 'west-end', openingDate: '2026-10-07', previewsStartDate: '2026-10-01',
};
const OAK = {
  id: 'an-oak-tree-off-west-end-2026', title: 'An Oak Tree', venue: 'The Other Palace - Main Theatre',
  category: 'off-west-end', openingDate: '2026-10-08', previewsStartDate: '2026-10-07',
};
const TKAM = {
  id: 'tkam-west-end-2026', title: 'To Kill a Mockingbird', venue: "Wyndham's Theatre",
  category: 'west-end', openingDate: '2026-06-30',
};

const JUNIPER = {
  outletId: 'london-box-office', criticName: 'Stuart King',
  url: 'https://www.londonboxoffice.co.uk/news/post/juniper-blood-donmar-warehouse-review',
  publishDate: '2025-08-28', wrongProduction: true, fullText: 'Juniper Blood review text.',
};
const BLOOD_URL = 'https://www.londonboxoffice.co.uk/news/post/blood-of-my-blood-royal-court-theatre-review';

function seed(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4956-'));
  const showDir = path.join(root, BLOOD.id);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [f, d] of Object.entries(files)) fs.writeFileSync(path.join(showDir, f), JSON.stringify(d));
  return { root, showDir };
}

test('dateless review naming this show supersedes a flagged other-show file', () => {
  assert.equal(flaggedSlotSupersededBy(JUNIPER, { url: BLOOD_URL }, BLOOD), true);
});

test('dated in-window review supersedes; dated out-of-window never does', () => {
  assert.equal(flaggedSlotSupersededBy(JUNIPER, { url: BLOOD_URL, publishDate: '2026-10-08' }, BLOOD), true);
  assert.equal(flaggedSlotSupersededBy(JUNIPER, { url: BLOOD_URL, publishDate: '2025-08-29' }, BLOOD), false);
});

test('an unflagged, locked or manually cleared slot is never superseded', () => {
  for (const patch of [{ wrongProduction: false }, { _locked: true }, { wrongProductionManualClear: true }, { duplicateOf: 'x.json' }]) {
    assert.equal(flaggedSlotSupersededBy({ ...JUNIPER, ...patch }, { url: BLOOD_URL }, BLOOD), false, JSON.stringify(patch));
  }
});

test('same url is the same record, not a supersede', () => {
  assert.equal(flaggedSlotSupersededBy({ ...JUNIPER, url: BLOOD_URL }, { url: BLOOD_URL }, BLOOD), false);
});

test('dateless incoming that does not name the show cannot take the slot', () => {
  assert.equal(flaggedSlotSupersededBy(JUNIPER, { url: 'https://www.londonboxoffice.co.uk/news/post/blood-knot-orange-tree-review' }, BLOOD), false);
});

test('same title, prior production: the current venue in the url is the evidence', () => {
  const youngVic = {
    outletId: 'thestage', criticName: 'Dave Fargnoli', wrongProduction: true, publishDate: '2025-05-07',
    url: 'https://www.thestage.co.uk/reviews/an-oak-tree-review-young-vic-london-tim-crouch-jessie-buckley',
  };
  const otherPalace = 'https://www.thestage.co.uk/reviews/an-oak-tree-review-the-other-palace-tim-crouch-gwyneth-keyworth';
  assert.equal(flaggedSlotSupersededBy(youngVic, { url: otherPalace }, OAK), true);
});

test('same title, no venue evidence, dateless: stays blocked (TKAM conservative rule)', () => {
  const gielgud = {
    outletId: 'standard', criticName: 'Nick Curtis', wrongProduction: true, publishDate: '2022-04-01',
    url: 'https://www.standard.co.uk/culture/theatre/to-kill-a-mockingbird-review-2022.html',
  };
  assert.equal(flaggedSlotSupersededBy(gielgud, { url: 'https://www.standard.co.uk/culture/theatre/to-kill-a-mockingbird-review-b123.html' }, TKAM), false);
});

test('url-year signal on the incoming blocks the supersede', () => {
  assert.equal(flaggedSlotSupersededBy(JUNIPER, { url: 'https://www.londonboxoffice.co.uk/2019/04/blood-of-my-blood-review' }, BLOOD), false);
});

test('detectIngestCollision lets the dateless same-critic review through', () => {
  const { root, showDir } = seed({ 'london-box-office--stuart-king.json': JUNIPER });
  const r = detectIngestCollision({ showDir, outletId: 'london-box-office', criticName: 'Stuart King', url: BLOOD_URL, show: BLOOD });
  assert.equal(r.ok, true, JSON.stringify(r));
  fs.rmSync(root, { recursive: true, force: true });
});

test('writer retires the flagged file to the graveyard and writes the review clean', () => {
  const { root, showDir } = seed({ 'london-box-office--stuart-king.json': JUNIPER });
  const res = createOrMergeReviewFile(BLOOD.id, {
    outletId: 'london-box-office', outlet: 'London Box Office', criticName: 'Stuart King',
    url: BLOOD_URL, source: 'url-ingest',
    fields: { publishDate: '2026-10-08', fullText: 'Blood of my Blood at the Royal Court. '.repeat(40) },
  }, { reviewTextsDir: root, show: BLOOD });
  assert.notEqual(res.action, 'skipped', JSON.stringify(res));
  const landed = JSON.parse(fs.readFileSync(path.join(showDir, 'london-box-office--stuart-king.json'), 'utf8'));
  assert.equal(landed.url, BLOOD_URL);
  assert.notEqual(landed.wrongProduction, true, 'the new review must not inherit the old flag');
  const grave = path.join(root, '_superseded-misattributed', `${BLOOD.id}--london-box-office--stuart-king.json`);
  const retired = JSON.parse(fs.readFileSync(grave, 'utf8'));
  assert.equal(retired.url, JUNIPER.url);
  assert.equal(retired.supersededBy, BLOOD_URL);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a cosmetic url variant of the flagged article never takes its slot', () => {
  const flaggedTimeout = {
    outletId: 'timeout-london', criticName: 'Tim Bano', wrongProduction: true, publishDate: '2026-09-22',
    url: 'https://www.timeout.com/london/theatre/an-oak-tree-review',
  };
  for (const u of [
    'http://timeout.com/london/theatre/an-oak-tree-review/?utm_source=x',
    'https://www.timeout.com/london/theatre/an-oak-tree-review/amp',
  ]) assert.equal(flaggedSlotSupersededBy(flaggedTimeout, { url: u, publishDate: '2026-10-08' }, OAK), false, u);
  const times = { ...JUNIPER, outletId: 'times-uk', url: 'https://www.thetimes.co.uk/article/blood-of-my-blood-review-abc' };
  assert.equal(flaggedSlotSupersededBy(times, { url: 'https://www.thetimes.com/article/blood-of-my-blood-review-abc', publishDate: '2026-10-08' }, BLOOD), false);
});

test('same publish date as the flagged record, or a human-confirmed flag: never superseded', () => {
  assert.equal(flaggedSlotSupersededBy({ ...JUNIPER, publishDate: '2026-10-08' }, { url: BLOOD_URL, publishDate: '2026-10-08' }, BLOOD), false);
  assert.equal(flaggedSlotSupersededBy({ ...JUNIPER, humanReviewedWrongProduction: true }, { url: BLOOD_URL }, BLOOD), false);
  assert.equal(flaggedSlotSupersededBy({ ...JUNIPER, wrongProductionOverride: true }, { url: BLOOD_URL }, BLOOD), false);
});

test('unresolved byline, dated in window: only when the url names the show (BRO-3182)', () => {
  const junk = { ...JUNIPER, outletId: 'times-uk', criticName: 'Unknown', url: 'https://www.thetimes.com/business/article/robots-ai-humanoid' };
  assert.equal(flaggedSlotSupersededBy(junk, { url: 'https://www.thetimes.com/culture/article/a-knock-at-the-door-h9cv', publishDate: '2026-10-08', criticNamed: false }, BLOOD), false);
  assert.equal(flaggedSlotSupersededBy(junk, { url: 'https://www.thetimes.com/culture/article/blood-of-my-blood-review-h9cv', publishDate: '2026-10-08', criticNamed: false }, BLOOD), true);
});

test('writer puts the flagged file back when a later guard refuses the write', () => {
  const { root, showDir } = seed({
    'london-box-office--stuart-king.json': JUNIPER,
    'london-box-office--other.json': { outletId: 'london-box-office', criticName: 'Other', url: 'https://www.londonboxoffice.co.uk/news/post/x', mergedDuplicateUrls: [BLOOD_URL] },
  });
  const res = createOrMergeReviewFile(BLOOD.id, {
    outletId: 'london-box-office', outlet: 'London Box Office', criticName: 'Stuart King',
    url: BLOOD_URL, source: 'url-ingest', fields: { publishDate: '2026-10-08' },
  }, { reviewTextsDir: root, show: BLOOD });
  assert.equal(res.action, 'skipped', JSON.stringify(res));
  const back = JSON.parse(fs.readFileSync(path.join(showDir, 'london-box-office--stuart-king.json'), 'utf8'));
  assert.equal(back.url, JUNIPER.url);
  assert.equal(back.wrongProduction, true);
  assert.equal(fs.existsSync(path.join(root, '_superseded-misattributed', `${BLOOD.id}--london-box-office--stuart-king.json`)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writer dry run reports the supersede without moving anything', () => {
  const { root, showDir } = seed({ 'london-box-office--stuart-king.json': JUNIPER });
  const res = createOrMergeReviewFile(BLOOD.id, {
    outletId: 'london-box-office', outlet: 'London Box Office', criticName: 'Stuart King',
    url: BLOOD_URL, source: 'url-ingest', fields: {},
  }, { reviewTextsDir: root, show: BLOOD, dryRun: true });
  assert.equal(res.action, 'would-supersede');
  assert.equal(JSON.parse(fs.readFileSync(path.join(showDir, 'london-box-office--stuart-king.json'), 'utf8')).url, JUNIPER.url);
  fs.rmSync(root, { recursive: true, force: true });
});
