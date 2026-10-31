// Submission-form junk guard: a NEW file from submit-review-form on a curated
// non-review page (ticket reseller, venue listing, press release) is refused;
// real reviews on hosts the broad classifier would wrongly reject
// (blogcritics.org, wbur.org /news/) still write; merges are never blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const SHOW = 'the-gin-game-2026';
const submit = (dir, outletId, url, extra = {}) => createOrMergeReviewFile(SHOW, {
  outletId, outlet: outletId, criticName: 'Unknown', url, source: 'submit-review-form',
  fields: { fullText: 'A review. '.repeat(80), ...extra },
}, { reviewTextsDir: dir });

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'submit-guard-')); }

test('refuses a NEW submission on a ticket reseller or curated listing page', () => {
  const dir = tmp();
  try {
    for (const [outlet, url] of [
      ['stuborder', 'https://www.stuborder.com/the-gin-game-august-2-2026-tickets/8129315'],
      ['eventticketscenter', 'https://www.eventticketscenter.com/the-gin-game-new-york-07-30-2026/8129312/t'],
      ['spincyclenyc', 'https://www.spincyclenyc.com/index.php/theater/823-bathroom-attendant'],
    ]) {
      const r = submit(dir, outlet, url);
      assert.equal(r.guardRefused, true, url);
      assert.match(r.reason, /^submitted-non-review-url: /, url);
    }
    assert.equal(fs.existsSync(path.join(dir, SHOW)), false, 'nothing written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('does not refuse real reviews the broad classifier would have rejected', () => {
  const dir = tmp();
  try {
    for (const [outlet, url] of [
      ['blogcritics', 'https://blogcritics.org/theater-review-nyc-the-real-ivanov-by-anton-chekhov/'],
      ['wbur', 'https://www.wbur.org/news/2026/08/25/american-repertory-theater-rhinoceros-review'],
      ['vocal', 'https://vocal.media/critique/bathroom-attendant'],
      ['new-york-city-theatre', 'https://www.newyorkcitytheatre.com/reviews/22099'],

    ]) {
      const r = submit(dir, outlet, url);
      assert.doesNotMatch(String(r.reason || ''), /submitted-non-review-url/, url);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('escape hatch and non-submission sources are unaffected', () => {
  const dir = tmp();
  try {
    const url = 'https://www.stuborder.com/the-gin-game-august-2-2026-tickets/8129315';
    const r = submit(dir, 'stuborder', url, { allowNonReviewUrl: true });
    assert.doesNotMatch(String(r.reason || ''), /submitted-non-review-url/);
    const r2 = createOrMergeReviewFile(SHOW, {
      outletId: 'stuborder', outlet: 'stuborder', criticName: 'Unknown', url, source: 'manual-entry',
      fields: { fullText: 'x '.repeat(200) },
    }, { reviewTextsDir: dir });
    assert.doesNotMatch(String(r2.reason || ''), /submitted-non-review-url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// BRO-5065: a Theatricalia production page (the play's description) was filed
// as a review for night-of-january-16th-off-broadway-2026. Production
// databases and encyclopedias are refused at write AND at validation, through
// the one shared decision both call.
const { submissionNonReviewReason } = require('./non-review-url-patterns.js');
const DATABASE_PAGES = [
  ['theatricalia', 'https://theatricalia.com/play/39r/night-of-january-16th/production/1b3b'],
  ['ibdb', 'https://www.ibdb.com/broadway-production/night-of-january-16th-11593'],
  ['lortel', 'https://www.lortel.org/Archives/Production/6012'],
  ['playbill', 'https://playbill.com/production/night-of-january-16th-theatre-row-2026'],
  ['wikipedia', 'https://en.wikipedia.org/wiki/Night_of_January_16th'],
];

test('BRO-5065: production-database and encyclopedia pages are refused at write', () => {
  const dir = tmp();
  try {
    for (const [outlet, url] of DATABASE_PAGES) {
      assert.ok(submissionNonReviewReason(url), `shared decision refuses ${url}`);
      const r = submit(dir, outlet, url);
      assert.equal(r.guardRefused, true, url);
      assert.match(r.reason, /^submitted-non-review-url: (production-database-listing|encyclopedia-page)$/, url);
    }
    assert.equal(fs.existsSync(path.join(dir, SHOW)), false, 'nothing written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-5065: Playbill articles and the exempt review hosts still pass the shared decision', () => {
  for (const url of [
    'https://playbill.com/article/review-night-of-january-16th-at-theatre-row',
    'https://vocal.media/critique/bathroom-attendant',
    'https://www.newyorkcitytheatre.com/reviews/22099',
    'https://blogcritics.org/theater-review-nyc-the-real-ivanov-by-anton-chekhov/',
    'https://susangranger.com/?p=10339',
  ]) assert.equal(submissionNonReviewReason(url), null, url);
  assert.equal(submissionNonReviewReason('https://www.newyorkcitytheatre.com/news/reviews/x'), 'ticketing-reseller');
  assert.equal(submissionNonReviewReason('not a url'), null);
  // Bare hosts are left to the read side (hash-routed SPAs, root-post blogs).
  assert.equal(submissionNonReviewReason('https://example.com/#/review/1'), null);
  assert.equal(submissionNonReviewReason('https://example.com/'), null);
  for (const u of ['https://playbill.com/shows/broadway', 'https://playbill.com/venues', 'https://playbill.com/person/ayn-rand']) {
    assert.equal(submissionNonReviewReason(u), 'production-database-listing', u);
  }
});

// The scoring-time / validator-side list (domain-filters.js) covers the same
// database hosts, so a row from any source is excluded, not only submissions.
const { isBlockedReviewUrl } = require('./domain-filters.js');
test('BRO-5065: isBlockedReviewUrl covers every production-database page too', () => {
  for (const [, url] of DATABASE_PAGES) assert.equal(isBlockedReviewUrl(url), true, url);
  assert.equal(isBlockedReviewUrl('https://www.lortel.org/news/2026-nominees'), false);
  assert.equal(isBlockedReviewUrl('https://playbill.com/article/review-night-of-january-16th'), false);
});

test('BRO-5275: refuses submissions on aggregator, event and listing hosts the validator blocks (show-score, showify, broadwaylog, recast, inyougo)', () => {
  const dir = tmp();
  try {
    for (const [outlet, url] of [
      ['show-score', 'https://www.show-score.com/off-broadway-shows/cat-cohen-broad-strokes'],
      ['showify', 'https://www.showify.us/shows/how-shakespeare-saved-my-life'],
      ['broadwaylog', 'https://broadwaylog.app/shows/how-shakespeare-saved-my-life-2026'],
      ['recast', 'https://www.recast.show/shows/the-body-of-mary-a-play-in-three-acts-of-god'],
      ['inyougo', 'https://inyougo.com/events/dinosaur-world-live'],
    ]) {
      const r = submit(dir, outlet, url);
      assert.equal(r.guardRefused, true, url);
      // show-score is refused earlier by the listing-page guard; the other four by this one.
      if (!/show-score/.test(url)) assert.match(r.reason, /^submitted-non-review-url: (blocked-domain|census-junk-host)/, url);
    }
    assert.equal(fs.existsSync(path.join(dir, SHOW)), false, 'nothing written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-5275: the vocal.media critique exemption survives the blocked-domain check', () => {
  const dir = tmp();
  try {
    const r = submit(dir, 'vocal', 'https://vocal.media/critique/bathroom-attendant', { criticName: 'A Critic' });
    assert.notEqual(r.guardRefused, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
