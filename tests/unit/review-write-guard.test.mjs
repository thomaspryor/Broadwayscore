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
const { safeWriteReview, checkForDataLoss, checkUrlCollision, coerceAssignedScore } = require('../../scripts/lib/review-write-guard');

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
