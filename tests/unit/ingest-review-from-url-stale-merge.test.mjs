/**
 * BRO-3790: ingest-review-from-url.js merge-into-existing silently preserves
 * stale url/criticName/fullText, reports false-positive "Updated".
 *
 * Hit live during BRO-3788 (talkinbroadway forum-thread-URL recovery,
 * 2026-09-18): 3 of 9 successful-looking ingest-review-from-url.js calls
 * reported "✅ Updated" but left the OLD dead-end forum URL / wrong
 * criticName / stale truncated fullText in place. Root cause:
 * createOrMergeReviewFile's merge-into-existing path (review-file-writer.js
 * _mergeIntoExisting) only fills fields that are currently BLANK on the
 * existing file; a non-blank-but-wrong value is silently kept.
 *
 * This exercises the REAL createOrMergeReviewFile merge path (not a copy)
 * against a fixture shaped exactly like the observed failure: an existing
 * file with a non-blank, different url and a "good enough" contentTier that
 * makes maybeUpgradeUrl's own badContent gate refuse the swap — then runs
 * the real findStaleMergeFields the same way ingest-review-from-url.js does
 * post-write, proving the fix reports (b) from the acceptance criteria
 * (explicit signal, never a silent "Updated" with the old data intact)
 * instead of a false-positive success.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
const { findExistingReviewFile } = require('../../scripts/lib/review-normalization');
const { findStaleMergeFields, isPreExistingContentBad } = require('../../scripts/lib/stale-merge-check');

function writeExisting(dir, showId, filename, data) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  return fp;
}

describe('BRO-3790: post-write stale-merge verification against the real writer', () => {
  test('re-ingesting a new URL onto a file with a non-blank, different, "good" url is silently kept by the writer — and the verification catches it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-stale-url-'));
    const OLD_URL = 'https://theaterpizzazz.com/dead-end-forum-thread/';
    const NEW_URL = 'https://theaterpizzazz.com/the-real-review-page/';
    const fp = writeExisting(dir, 'stale-merge-url-show', 'theater-pizzazz--unknown.json', {
      showId: 'stale-merge-url-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Unknown',
      url: OLD_URL,
      // contentTier 'complete' + non-empty fullText makes maybeUpgradeUrl's
      // own badContent gate refuse to swap the url — the exact "good enough,
      // don't touch" shape that let the forum-thread url survive re-ingest.
      contentTier: 'complete',
      fullText: 'A complete-looking review body that reads as real content and is long enough to pass every length gate cleanly. '.repeat(4),
    });

    const res = createOrMergeReviewFile('stale-merge-url-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: NEW_URL,
      source: 'url-ingest',
      fields: {},
    }, { reviewTextsDir: dir });

    // Reproduce the bug: the writer's own action verb never says "refused" —
    // this is exactly what a caller printing "✅ Updated" on any non-skip
    // action would get wrong.
    assert.notEqual(res.action, 'skipped', 'sanity: the writer does not signal a refusal here');

    const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(landed.url, OLD_URL, 'sanity: reproduces the silent-preserve bug — url on disk never changed');

    // This is exactly what ingest-review-from-url.js now does after a
    // reported 'updated' action, before ever printing "✅ Updated".
    const stale = findStaleMergeFields({ url: NEW_URL }, landed);
    assert.deepEqual(stale, ['url'], 'the intended url correction must be flagged stale, not reported as a silent success');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a genuine fill-blank merge (the common, correct case) reports no stale fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-clean-merge-'));
    const NEW_URL = 'https://theaterpizzazz.com/the-real-review-page/';
    const NEW_TEXT = 'Freshly extracted review text that is long enough to read as a real review body. '.repeat(4);
    const fp = writeExisting(dir, 'clean-merge-show', 'theater-pizzazz--unknown.json', {
      showId: 'clean-merge-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Unknown',
      url: '',
      fullText: '',
    });

    const res = createOrMergeReviewFile('clean-merge-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: NEW_URL,
      source: 'url-ingest',
      fields: { fullText: NEW_TEXT },
    }, { reviewTextsDir: dir });

    assert.equal(res.action, 'updated');
    const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const stale = findStaleMergeFields({ url: NEW_URL, fullText: NEW_TEXT }, landed);
    assert.deepEqual(stale, [], 'a legitimate fill-blank merge must never be flagged stale');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a re-extraction of an ALREADY-complete file is never flagged stale on incidental text drift (Codex adversarial finding)', () => {
    // A fresh fetch of a page whose content hasn't changed can still extract
    // slightly different text (rotating ad copy, site chrome) than what's
    // already stored — that's not the file being wrong, so the fullText
    // check must be skipped whenever the pre-existing content was already
    // good, exactly like maybeUpgradeUrl's own badContent gate for url.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-good-content-'));
    const SAME_URL = 'https://theaterpizzazz.com/the-real-review-page/';
    const STORED_TEXT = 'A complete, correct review body that was already fine before this re-ingest ever ran. '.repeat(4);
    const FRESH_EXTRACTION = 'A complete, correct review body that was already fine before this re-ingest ever ran, but the ad slot rendered a different promo this time. '.repeat(4);
    const showDir = writeExisting(dir, 'good-content-show', 'theater-pizzazz--unknown.json', {
      showId: 'good-content-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Unknown',
      url: SAME_URL,
      contentTier: 'complete',
      fullText: STORED_TEXT,
    });

    const preExisting = findExistingReviewFile(dir + '/good-content-show', 'theater-pizzazz', null, SAME_URL);
    assert.ok(preExisting, 'sanity: the pre-write lookup finds the existing file');
    assert.equal(isPreExistingContentBad(preExisting), false, 'an already-complete file with real text is not "bad"');

    createOrMergeReviewFile('good-content-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: SAME_URL,
      source: 'url-ingest',
      fields: { fullText: FRESH_EXTRACTION },
    }, { reviewTextsDir: dir });

    const landed = JSON.parse(fs.readFileSync(showDir, 'utf8'));
    assert.equal(landed.fullText, STORED_TEXT, 'sanity: the writer correctly preserved the already-good body, not the fresh extraction');

    // This mirrors ingest-review-from-url.js's own gating exactly: fullText
    // is only added to `intended` when the pre-existing content was bad.
    const intended = { url: SAME_URL };
    if (isPreExistingContentBad(preExisting)) intended.fullText = FRESH_EXTRACTION;
    const stale = findStaleMergeFields(intended, landed);
    assert.deepEqual(stale, [], 'an already-good file must never be flagged stale just because a re-fetch extracted slightly different text');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a benign "skipped: no-changes" outcome that never corrected the url is still caught (Codex P1 finding)', () => {
    // Codex adversarial finding: gating the verification on action==='updated'
    // alone misses the case where NOTHING changed at all (source already
    // recorded, content already "good" so the url-swap was refused) — the
    // writer returns action:'skipped', reason:'no-changes', which the CLI
    // already printed as a benign, exit-0 "⚠️  Skipped" before this fix. The
    // intended correction (a new url) still silently failed to land there
    // too, so the check must run for that outcome, not just 'updated'.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-no-changes-'));
    const OLD_URL = 'https://theaterpizzazz.com/dead-end-forum-thread/';
    const NEW_URL = 'https://theaterpizzazz.com/the-real-review-page/';
    const showDir = writeExisting(dir, 'no-changes-show', 'theater-pizzazz--unknown.json', {
      showId: 'no-changes-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Unknown',
      url: OLD_URL,
      contentTier: 'complete',
      fullText: 'A complete-looking review body that reads as real content and is long enough to pass every length gate cleanly. '.repeat(4),
      sources: ['url-ingest'], // already recorded — the sources[] merge below has nothing new to add
    });

    const res = createOrMergeReviewFile('no-changes-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: NEW_URL,
      source: 'url-ingest',
      fields: {},
    }, { reviewTextsDir: dir });

    assert.deepEqual(res, { action: 'skipped', reason: 'no-changes', filepath: showDir },
      'sanity: the writer reports a benign no-op, not a refusal — this is the case the old action==="updated" gate missed');

    const landed = JSON.parse(fs.readFileSync(showDir, 'utf8'));
    const stale = findStaleMergeFields({ url: NEW_URL }, landed);
    assert.deepEqual(stale, ['url'], 'the intended url correction must be flagged stale even though the writer called it a benign no-op');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
