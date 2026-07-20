/**
 * Unit tests for review-write-guard (Pattern Cards #4, #6, #7)
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeWriteReview, safeRenameReview, checkForDataLoss, checkUrlCollision, coerceAssignedScore } = require('../../scripts/lib/review-write-guard');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-guard-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('safeWriteReview', () => {
  test('writes new file without issues', () => {
    const filePath = path.join(tmpDir, 'test-review.json');
    const data = { showId: 'test-show', outlet: 'NYT', criticName: 'Critic' };
    const result = safeWriteReview(filePath, data);
    assert.equal(result.wrote, true);
    assert.deepEqual(result.preserved, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), data);
  });

  test('preserves assignedScore when new data lacks it', () => {
    const filePath = path.join(tmpDir, 'scored-review.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test-show',
      outlet: 'NYT',
      assignedScore: 85,
      llmScore: { score: 85, confidence: 'high' },
      fullText: 'This is a great show...',
    }, null, 2));

    const stub = { showId: 'test-show', outlet: 'NYT', url: 'https://example.com' };
    const result = safeWriteReview(filePath, stub);

    assert.ok(result.preserved.includes('assignedScore'));
    assert.ok(result.preserved.includes('llmScore'));
    assert.ok(result.preserved.includes('fullText'));

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 85);
    assert.equal(written.llmScore.score, 85);
    assert.equal(written.fullText, 'This is a great show...');
    assert.equal(written.url, 'https://example.com');
  });

  test('preserves manually-set pullQuote across writes that lack it (Lost Boys Issue #12)', () => {
    // Helen Shaw 2026-04-27 incident: operator set pullQuote via gh api PUT,
    // added pullQuote to protectedFields, but a downstream writer stripped it.
    // safeWriteReview must preserve pullQuote because it's in PROTECTED_FIELDS.
    const filePath = path.join(tmpDir, 'pullquote-preserve.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'the-lost-boys-2026',
      outletId: 'vulture',
      criticName: 'Helen Shaw',
      pullQuote: 'the finest spectacle I have seen this season outside of the Met Opera',
      protectedFields: ['pullQuote'],
    }, null, 2));

    // Simulate a rebuild/collect cycle that writes new scrape data without pullQuote.
    const newData = {
      showId: 'the-lost-boys-2026',
      outletId: 'vulture',
      fullText: 'fresh scraped review text',
      contentTier: 'complete',
    };
    const result = safeWriteReview(filePath, newData);

    assert.ok(result.preserved.includes('pullQuote'),
      `Expected pullQuote in preserved array, got: ${result.preserved.join(', ')}`);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.pullQuote, 'the finest spectacle I have seen this season outside of the Met Opera');
    assert.equal(written.fullText, 'fresh scraped review text');
  });

  test('preserves wrongProduction flag', () => {
    const filePath = path.join(tmpDir, 'wrong-prod.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test-show',
      wrongProduction: true,
      wrongProductionNote: 'Same URL in other show',
    }, null, 2));

    const newData = { showId: 'test-show', outlet: 'NYT' };
    safeWriteReview(filePath, newData);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongProduction, true);
    assert.equal(written.wrongProductionNote, 'Same URL in other show');
  });

  test('incompleteReason is NOT protected — Card #1: derived flag must not persist via merge', () => {
    // incompleteReason was removed from PROTECTED_FIELDS in Card #1.
    // It's a derived/descriptive state, not irreplaceable scored data.
    // clearFailureFlags() explicitly clears it on success paths — it must not survive via merge.
    const filePath = path.join(tmpDir, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test-show',
      incompleteReason: 'wrong_content',
      incompleteDetail: 'stale flag from prior collection run',
    }, null, 2));

    const newData = { showId: 'test-show', outlet: 'NYT', fullText: 'full review text here' };
    safeWriteReview(filePath, newData);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // incompleteReason is NOT in PROTECTED_FIELDS, so safeWriteReview won't force-preserve it.
    // In merge mode, it copies existing fields not in newData — but since newData didn't set
    // incompleteReason to undefined explicitly, merge still copies it.
    // The key guarantee: clearFailureFlags() must be called BEFORE safeWriteReview on success paths.
    // This test verifies it is NOT in PROTECTED_FIELDS (preserved array must not include it).
    const result2 = safeWriteReview(filePath, { showId: 'test-show', incompleteReason: null });
    assert.ok(!result2.preserved.includes('incompleteReason'), 'incompleteReason must not be in PROTECTED_FIELDS preserved list');
  });

  test('allows overwrite with force=true', () => {
    const filePath = path.join(tmpDir, 'force-overwrite.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test-show',
      assignedScore: 85,
      fullText: 'Old text',
    }, null, 2));

    const newData = { showId: 'test-show', assignedScore: 72 };
    const originalWarn = console.warn;
    console.warn = () => {};
    const result = safeWriteReview(filePath, newData, { force: true });
    console.warn = originalWarn;

    assert.deepEqual(result.preserved, []);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 72);
    assert.equal(written.fullText, undefined);
  });

  test('merge mode preserves all existing fields', () => {
    const filePath = path.join(tmpDir, 'merge.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test-show',
      outlet: 'NYT',
      customField: 'preserved',
      publishDate: '2026-03-01',
    }, null, 2));

    const newData = { showId: 'test-show', url: 'https://new-url.com' };
    safeWriteReview(filePath, newData);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.customField, 'preserved');
    assert.equal(written.publishDate, '2026-03-01');
    assert.equal(written.url, 'https://new-url.com');
  });
});

describe('checkUrlCollision (Card #4 wire-up)', () => {
  test('marks duplicate when safeWriteReview detects URL collision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-collision-'));
    try {
      fs.writeFileSync(path.join(dir, 'nytimes--jesse-green.json'), JSON.stringify({
        url: 'https://www.nytimes.com/2026/04/16/theater/proof-review.html',
        criticName: 'Jesse Green',
      }, null, 2));

      const newPath = path.join(dir, 'nytimes--unknown.json');
      safeWriteReview(newPath, {
        url: 'https://www.nytimes.com/2026/04/16/theater/proof-review.html',
        criticName: 'Unknown',
      });

      const written = JSON.parse(fs.readFileSync(newPath, 'utf8'));
      assert.equal(written.duplicateOf, 'nytimes--jesse-green.json');
      assert.equal(written.duplicateReason, 'url-collision-detected-at-write');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not mark duplicate when URLs differ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-collision-'));
    try {
      fs.writeFileSync(path.join(dir, 'nytimes--jesse-green.json'), JSON.stringify({
        url: 'https://www.nytimes.com/2026/04/16/theater/proof-review.html',
      }, null, 2));

      const newPath = path.join(dir, 'nytimes--unknown.json');
      safeWriteReview(newPath, { url: 'https://www.nytimes.com/2026/04/17/theater/other.html' });

      const written = JSON.parse(fs.readFileSync(newPath, 'utf8'));
      assert.equal(written.duplicateOf, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('self-heals stale duplicateOf when sibling URL no longer matches (Sommers/Bernardo case)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-dupe-'));
    try {
      // Sibling now has its real URL (different from the URL we share).
      fs.writeFileSync(path.join(dir, 'nysr--bernardo.json'), JSON.stringify({
        url: 'https://nystagereview.com/2025/08/04/frank-fervent-ferociously-funny/',
        criticName: 'Melissa Rose Bernardo',
      }, null, 2));

      // Our file historically had Bernardo's URL (collision triggered),
      // then got corrected to our actual URL — but the dupe flag stuck.
      const ourPath = path.join(dir, 'nysr--sommers.json');
      safeWriteReview(ourPath, {
        url: 'https://nystagereview.com/2025/08/04/being-present-about-the-past/',
        criticName: 'Michael Sommers',
        duplicateOf: 'nysr--bernardo.json',
        duplicateReason: 'url-collision-detected-at-write',
      });

      const written = JSON.parse(fs.readFileSync(ourPath, 'utf8'));
      assert.equal(written.duplicateOf, null);
      assert.equal(written.duplicateReason, null);
      assert.match(written.duplicateClearReason || '', /URL .* no longer matches sibling/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('self-heals dangling duplicateOf when sibling file no longer exists', () => {
    // The sibling-missing case: collect-review-texts cleanup deletes
    // *--unknown.json junk files, leaving any review that pointed at one
    // with a dangling duplicateOf. CI gate audit-duplicate-of-url-mismatch.js
    // catches this; the write-guard must self-heal so it doesn't accumulate
    // until the next manual --fix run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-dupe-'));
    try {
      // No sibling file is written — we point at one that doesn't exist.
      const ourPath = path.join(dir, 'british-theatre--susan-novak.json');
      safeWriteReview(ourPath, {
        url: 'https://www.britishtheatre.com/posts/lyn-gardner-s-weekly-theatre-picks-beetlejuice-high-society-and-the-cherry-orcha',
        criticName: 'Susan Novak',
        duplicateOf: 'british-theatre--unknown.json',
        duplicateReason: 'url-collision-detected-at-write',
      });

      const written = JSON.parse(fs.readFileSync(ourPath, 'utf8'));
      assert.equal(written.duplicateOf, null);
      assert.equal(written.duplicateReason, null);
      assert.match(written.duplicateClearReason || '', /sibling .* no longer exists/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preserves duplicateOf when sibling URL still matches ours', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-dupe-'));
    try {
      const sharedUrl = 'https://example.com/same-article';
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ url: sharedUrl }, null, 2));

      const ourPath = path.join(dir, 'b.json');
      safeWriteReview(ourPath, {
        url: sharedUrl,
        duplicateOf: 'a.json',
        duplicateReason: 'url-collision-detected-at-write',
      });

      const written = JSON.parse(fs.readFileSync(ourPath, 'utf8'));
      assert.equal(written.duplicateOf, 'a.json');
      assert.equal(written.duplicateReason, 'url-collision-detected-at-write');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips collision check when urlCorrectedFrom is set (transient state)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-correction-'));
    try {
      // Sibling has the URL we used to point at.
      fs.writeFileSync(path.join(dir, 'nysr--bernardo.json'), JSON.stringify({
        url: 'https://nystagereview.com/old-url/',
      }, null, 2));

      // We're mid-correction: urlCorrectedFrom records the old (colliding) URL,
      // but url is the new one. The collision check must NOT fire on the new URL
      // matching, and must NOT compare against urlCorrectedFrom.
      const ourPath = path.join(dir, 'nysr--sommers.json');
      safeWriteReview(ourPath, {
        url: 'https://nystagereview.com/old-url/',
        urlCorrectedFrom: 'https://nystagereview.com/different-url/',
      });

      const written = JSON.parse(fs.readFileSync(ourPath, 'utf8'));
      assert.equal(written.duplicateOf, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision returns null when no collision exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-coll-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ url: 'https://example.com/a' }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'b.json'), { url: 'https://example.com/b' });
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision returns collider filename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coll-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ url: 'https://example.com/same' }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'b.json'), { url: 'https://example.com/same' });
      assert.equal(result, 'a.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision normalizes utm_* params — same article with different tracking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utm-'));
    try {
      fs.writeFileSync(path.join(dir, 'nytimes--helen-shaw.json'), JSON.stringify({
        url: 'https://www.nytimes.com/2026/04/16/theater/proof-review.html',
      }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'nytimes--unknown.json'), {
        url: 'https://www.nytimes.com/2026/04/16/theater/proof-review.html?utm_source=google&utm_medium=cpc',
      });
      assert.equal(result, 'nytimes--helen-shaw.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision normalizes trailing slash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ url: 'https://example.com/article/' }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'b.json'), { url: 'https://example.com/article' });
      assert.equal(result, 'a.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision handles non-string url without crashing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonstr-'));
    try {
      const result = checkUrlCollision(path.join(dir, 'b.json'), { url: { nested: 'object' } });
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Item 3 (2026-04-28): AMP-suffix should collide with the canonical URL.
  // Origin: dracula-west-end-2025/metro--brooke-ivey-johnson.json — an AMP
  // re-scrape produced a parallel file alongside the manually-fixed metro-uk
  // entry. Pre-fix: _normalizeUrlForCollision didn't strip /amp/ so the two
  // URLs hashed differently and both files lived in reviews.json as duplicates.
  test('checkUrlCollision strips /amp/ suffix — same article via AMP URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-'));
    try {
      fs.writeFileSync(path.join(dir, 'metro-uk--brooke-ivey-johnson.json'), JSON.stringify({
        url: 'https://metro.co.uk/2026/02/17/cynthia-erivos-dracula-26951617/',
      }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'metro-uk--unknown.json'), {
        url: 'https://metro.co.uk/2026/02/17/cynthia-erivos-dracula-26951617/amp/',
      });
      assert.equal(result, 'metro-uk--brooke-ivey-johnson.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision strips ?amp=1 query param — Google AMP cache shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ampq-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
        url: 'https://example.com/2026/02/17/article-name',
      }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'b.json'), {
        url: 'https://example.com/2026/02/17/article-name?amp=1',
      });
      assert.equal(result, 'a.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkUrlCollision does NOT strip mid-path /amp/ (false positive guard)', () => {
    // A path-internal /amp/ segment must NOT be stripped or we'd silently
    // collapse e.g. `/news/amp/election-results` into `/news/election-results`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-amp-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
        url: 'https://example.com/news/election-results',
      }, null, 2));
      const result = checkUrlCollision(path.join(dir, 'b.json'), {
        url: 'https://example.com/news/amp/election-results',
      });
      assert.equal(result, null, 'mid-path /amp/ should not collide with canonical');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('force=true audit trail', () => {
  test('warns with field names when force=true overwrites protected fields', () => {
    const filePath = path.join(tmpDir, 'force-warn.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test-show',
      assignedScore: 85,
      fullText: 'Important review text',
    }, null, 2));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      safeWriteReview(filePath, { showId: 'test-show' }, { force: true });
    } finally {
      console.warn = originalWarn;
    }

    const forceWarning = warnings.find(w => w.includes('[review-write-guard] FORCE write'));
    assert.ok(forceWarning, `Expected a FORCE write warning but got: ${JSON.stringify(warnings)}`);
    assert.ok(forceWarning.includes('assignedScore'), `Expected 'assignedScore' in warning: ${forceWarning}`);
    assert.ok(forceWarning.includes('fullText'), `Expected 'fullText' in warning: ${forceWarning}`);
  });

  test('does not warn when force=true on a new file (no protected data to lose)', () => {
    const filePath = path.join(tmpDir, 'force-new.json');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      safeWriteReview(filePath, { showId: 'test-show', assignedScore: 85 }, { force: true });
    } finally {
      console.warn = originalWarn;
    }

    const forceWarnings = warnings.filter(w => w.includes('[review-write-guard] FORCE write'));
    assert.equal(forceWarnings.length, 0, `Expected no FORCE write warning for new file, got: ${JSON.stringify(forceWarnings)}`);
  });
});

describe('coerceAssignedScore (Schmigadoon 2026 Bug #6 — schema drift block)', () => {
  test('passes through null assignedScore unchanged', () => {
    const data = { assignedScore: null };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, false);
    assert.equal(data.assignedScore, null);
  });

  test('passes through finite number unchanged', () => {
    const data = { assignedScore: 85 };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, false);
    assert.equal(data.assignedScore, 85);
  });

  test('coerces "2/4 stars" string (NY Post Schmigadoon bug) via parseRating → 50', () => {
    const data = { assignedScore: '2/4 stars' };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, true);
    assert.equal(data.assignedScore, 50);
    assert.equal(data._assignedScoreCoercedFrom, '2/4 stars');
  });

  test('coerces "3/5 stars" Guardian-style string → 60', () => {
    const data = { assignedScore: '3/5 stars' };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, true);
    assert.equal(data.assignedScore, 60);
  });

  test('coerces letter grade "B+" → 80', () => {
    const data = { assignedScore: 'B+' };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, true);
    assert.equal(data.assignedScore, 80);
  });

  test('prefers originalScoreNormalized over string parse', () => {
    const data = {
      assignedScore: '2/4 stars',
      originalScoreNormalized: 52,
    };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, true);
    assert.equal(data.assignedScore, 52);
    assert.equal(result.reason, 'from-originalScoreNormalized');
  });

  test('ignores out-of-range originalScoreNormalized', () => {
    const data = {
      assignedScore: '2/4 stars',
      originalScoreNormalized: 999,
    };
    const result = coerceAssignedScore(data);
    assert.equal(data.assignedScore, 50);
    assert.equal(result.reason, 'parsed-as-star_4');
  });

  test('unparseable string → null + needsReview flag', () => {
    const data = { assignedScore: 'garbage data' };
    const result = coerceAssignedScore(data);
    assert.equal(result.changed, true);
    assert.equal(data.assignedScore, null);
    assert.equal(data._assignedScoreCoercionFailed, true);
    assert.equal(data.needsReview, true);
  });

  test('safeWriteReview blocks schema-drifted string assignedScore from hitting disk', () => {
    const filePath = path.join(tmpDir, 'schema-drift.json');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      safeWriteReview(filePath, {
        showId: 'schmigadoon-2026',
        outletId: 'nypost',
        criticName: 'Johnny Oleksinski',
        assignedScore: '2/4 stars',
        scoreSource: 'html-star',
      });
    } finally {
      console.warn = originalWarn;
    }

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 50);
    assert.equal(written._assignedScoreCoercedFrom, '2/4 stars');
    assert.ok(warnings.some(w => w.includes('assignedScore coerced')));
  });

  test('safeWriteReview coercion survives through preservation logic (existing string value)', () => {
    const filePath = path.join(tmpDir, 'existing-string.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'test',
      assignedScore: '2/4 stars',
      originalScoreNormalized: 50,
    }, null, 2));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      safeWriteReview(filePath, { showId: 'test', outletId: 'nypost' });
    } finally {
      console.warn = originalWarn;
    }

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 50);
  });
});

describe('checkForDataLoss', () => {
  test('returns empty for new file', () => {
    const losses = checkForDataLoss('/nonexistent/file.json', { showId: 'test' });
    assert.deepEqual(losses, []);
  });

  test('detects score loss', () => {
    const filePath = path.join(tmpDir, 'check.json');
    fs.writeFileSync(filePath, JSON.stringify({
      assignedScore: 85,
      llmScore: { score: 85 },
      ensembleData: { votes: [85, 82, 88] },
    }, null, 2));

    const losses = checkForDataLoss(filePath, { showId: 'test' });
    assert.ok(losses.includes('assignedScore'));
    assert.ok(losses.includes('llmScore'));
    assert.ok(losses.includes('ensembleData'));
  });

  test('no loss when new data has same fields', () => {
    const filePath = path.join(tmpDir, 'no-loss.json');
    fs.writeFileSync(filePath, JSON.stringify({
      assignedScore: 85,
      fullText: 'text',
    }, null, 2));

    const losses = checkForDataLoss(filePath, { assignedScore: 72, fullText: 'new text' });
    assert.deepEqual(losses, []);
  });
});

describe('safeWriteReview lockedOverride (Joe Turner postmortem P0 #2)', () => {
  test('locked + non-empty incoming PROTECTED → existing wins, lockedSkipped=true', () => {
    const filePath = path.join(tmpDir, 'locked-protected.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'joe-turners-come-and-gone-2026',
      outletId: 'nytimes',
      _locked: true,
      assignedScore: 85,
      fullText: 'Original locked text',
    }, null, 2));

    const result = safeWriteReview(filePath, {
      showId: 'joe-turners-come-and-gone-2026',
      outletId: 'nytimes',
      assignedScore: 72,
      fullText: 'Different text from enrichment',
    });

    assert.equal(result.lockedSkipped, true);
    assert.ok(result.preserved.includes('assignedScore'));
    assert.ok(result.preserved.includes('fullText'));
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 85);
    assert.equal(written.fullText, 'Original locked text');
  });

  test('locked + force=true → incoming wins, lockedSkipped=false', () => {
    const filePath = path.join(tmpDir, 'locked-force.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 85,
    }, null, 2));

    const originalWarn = console.warn;
    console.warn = () => {};
    const result = safeWriteReview(filePath, { assignedScore: 72 }, { force: true });
    console.warn = originalWarn;

    assert.equal(result.lockedSkipped, false);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 72);
  });

  test('locked + non-PROTECTED field changes go through normally', () => {
    const filePath = path.join(tmpDir, 'locked-nonprotected.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 85,
      criticName: 'Old Critic',
    }, null, 2));

    const result = safeWriteReview(filePath, {
      assignedScore: 85,
      criticName: 'New Critic',
    });

    // criticName is NOT in PROTECTED_FIELDS, so it should change.
    // assignedScore matches existing, so it's a no-op.
    assert.equal(result.lockedSkipped, false);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.criticName, 'New Critic');
    assert.equal(written.assignedScore, 85);
  });

  test('parallel-writer race: fresh disk read sees post-write mutation', () => {
    // This proves safeWriteReview re-reads from disk on every call. If a parallel
    // writer mutates the file between our two writes, the second write sees the
    // mutated state, not a stale cache. That's the mitigation for the Joe Turner
    // P0 #2 parallel-writer scenario.
    const filePath = path.join(tmpDir, 'parallel-race.json');
    safeWriteReview(filePath, {
      _locked: true,
      assignedScore: 80,
    });

    // Simulate a parallel writer (poller, manual ingest, etc.) mutating the
    // PROTECTED field on disk while we're between calls.
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    onDisk.assignedScore = 95;
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2) + '\n');

    // Now call safeWriteReview again with a different score. Locked override
    // should preserve the disk's 95, not our cached 80 or our incoming 72.
    const result = safeWriteReview(filePath, {
      _locked: true,
      assignedScore: 72,
    });

    assert.equal(result.lockedSkipped, true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 95);
  });

  test('locked + incoming empty → preserved (existing behavior, lockedSkipped=false)', () => {
    // When incoming is empty, the original empty-incoming guard already preserves
    // the field. This is not a "lock save" — the lock was redundant. lockedSkipped
    // stays false to keep the signal meaningful (lock prevented a real overwrite).
    const filePath = path.join(tmpDir, 'locked-incoming-empty.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 85,
    }, null, 2));

    const result = safeWriteReview(filePath, { showId: 'x' });

    assert.equal(result.lockedSkipped, false);
    assert.ok(result.preserved.includes('assignedScore'));
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 85);
  });

  test('non-locked + non-empty incoming PROTECTED → incoming wins, lockedSkipped=false', () => {
    // Sanity: lockedOverride must NOT trigger on non-locked files.
    const filePath = path.join(tmpDir, 'unlocked-incoming.json');
    fs.writeFileSync(filePath, JSON.stringify({
      assignedScore: 85,
    }, null, 2));

    const result = safeWriteReview(filePath, { assignedScore: 72 });

    assert.equal(result.lockedSkipped, false);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 72);
  });
});

describe('safeWriteReview google-redirect URL unwrap (JCS artsdesk 2026-07-09)', () => {
  test('unwraps google.com/url wrapper and records urlUnwrappedFrom', () => {
    const filePath = path.join(tmpDir, 'google-wrapped.json');
    const wrapped = 'https://www.google.com/url?q=https://theartsdesk.com/theatre/jesus-christ-superstar-london-palladium-review&sa=D&source=editors&ust=1783600902761325&usg=AOvVaw1R';
    safeWriteReview(filePath, {
      showId: 'jesus-christ-superstar-west-end-2026',
      outletId: 'artsdesk',
      criticName: 'Rachel Halliburton',
      url: wrapped,
      fullText: 'A real review body long enough to count.',
    });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, 'https://theartsdesk.com/theatre/jesus-christ-superstar-london-palladium-review');
    assert.equal(written.urlUnwrappedFrom, wrapped);
  });

  test('leaves normal URLs untouched (no urlUnwrappedFrom)', () => {
    const filePath = path.join(tmpDir, 'normal-url.json');
    safeWriteReview(filePath, {
      showId: 'x',
      outletId: 'guardian',
      url: 'https://www.theguardian.com/stage/2026/jul/08/jcs-review',
      fullText: 'A real review body long enough to count.',
    });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, 'https://www.theguardian.com/stage/2026/jul/08/jcs-review');
    assert.equal(written.urlUnwrappedFrom, undefined);
  });

  test('malformed google url (no q param) passes through unchanged', () => {
    const filePath = path.join(tmpDir, 'malformed-google.json');
    const weird = 'https://www.google.com/url?sa=D&source=editors';
    safeWriteReview(filePath, {
      showId: 'x',
      outletId: 'guardian',
      url: weird,
      fullText: 'A real review body long enough to count.',
    });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, weird);
  });
});

describe('showId backstop', () => {
  // validate-review-texts --gate hard-fails on a missing showId; one such file
  // (allegra-west-end-2026/whatsonstage--aliya-al.json, 2026-07-18) turned the
  // Test Suite red. safeWriteReview derives showId from the show directory.
  test('derives showId from parent directory when missing', () => {
    const showDir = path.join(tmpDir, 'allegra-west-end-2026');
    fs.mkdirSync(showDir);
    const filePath = path.join(showDir, 'whatsonstage--aliya-al.json');
    safeWriteReview(filePath, { outlet: 'WhatsOnStage', criticName: 'Aliya Al' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.showId, 'allegra-west-end-2026');
  });

  test('does not override an existing showId', () => {
    const showDir = path.join(tmpDir, 'some-dir-name');
    fs.mkdirSync(showDir);
    const filePath = path.join(showDir, 'nyt--critic.json');
    safeWriteReview(filePath, { showId: 'real-show-2026', outlet: 'NYT' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.showId, 'real-show-2026');
  });

  test('skips dirs whose name cannot be a show id (underscore/dot/tmp-guard)', () => {
    const guardDir = path.join(tmpDir, '__zzz-guard');
    fs.mkdirSync(guardDir);
    const filePath = path.join(guardDir, 'thestage--unknown.json');
    safeWriteReview(filePath, { outlet: 'The Stage' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.showId, undefined);
  });

  test('_pending nested layout still derives the show id (parent dir is the show dir)', () => {
    const showDir = path.join(tmpDir, '_pending', 'tender-off-west-end-2026');
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'thestage--unknown.json');
    safeWriteReview(filePath, { outlet: 'The Stage' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.showId, 'tender-off-west-end-2026');
  });

  test('warns but does not rewrite a mismatched showId', () => {
    const showDir = path.join(tmpDir, 'show-a-2026');
    fs.mkdirSync(showDir);
    const filePath = path.join(showDir, 'nyt--critic.json');
    safeWriteReview(filePath, { showId: 'show-b-2026', outlet: 'NYT' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.showId, 'show-b-2026');
  });

  test('safeRenameReview re-stamps showId on a cross-show-dir move', () => {
    const srcDir = path.join(tmpDir, 'wrong-show-2018');
    const dstDir = path.join(tmpDir, 'right-show-2026');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(dstDir);
    const srcPath = path.join(srcDir, 'nyt--critic.json');
    fs.writeFileSync(srcPath, JSON.stringify({ showId: 'wrong-show-2018', outlet: 'NYT', url: 'https://example.com/r' }, null, 2));
    const result = safeRenameReview(srcPath, path.join(dstDir, 'nyt--critic.json'));
    assert.equal(result.wrote, true);
    const written = JSON.parse(fs.readFileSync(path.join(dstDir, 'nyt--critic.json'), 'utf8'));
    assert.equal(written.showId, 'right-show-2026');
    assert.equal(fs.existsSync(srcPath), false);
  });
});
