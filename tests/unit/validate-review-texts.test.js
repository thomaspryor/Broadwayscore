'use strict';

/**
 * Unit tests for scripts/validate-review-texts.js.
 *
 * CLAUDE.md §15: never re-copy validation logic into a test file — require()
 * the real function. validateReviewFile(filePath, validOutlets, seenReviews)
 * does its own file I/O, so each test writes a real fixture file under a
 * temp dir (fs.mkdtempSync pattern from tests/unit/json-conflict-marker.test.mjs)
 * and asserts on the real function's output, including the checks the
 * previous hand-copied version never exercised: aggregator_contamination,
 * aggregator_url_mismatch, and broken_duplicate_ref.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateReviewFile } = require('../../scripts/validate-review-texts.js');

function makeTmpShowDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-review-texts-test-'));
}

function writeReview(dir, filename, data) {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function withTmpShowDir(fn) {
  const dir = makeTmpShowDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const KNOWN_OUTLET = 'chicagotribune';

// ----------------------------------------------------------------------------
// Required fields (errors)
// ----------------------------------------------------------------------------

test('valid review passes with no errors or warnings', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.chicagotribune.com/hamilton-review',
      fullText: 'A review of the show.',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });
});

test('missing showId is a required_fields error', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(result.errors.some((e) => e.check === 'required_fields' && /showId/.test(e.message)));
  });
});

test('missing outlet and outletId is a required_fields error', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      criticName: 'Chris Jones',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(result.errors.some((e) => e.check === 'required_fields' && /outletId or outlet/.test(e.message)));
  });
});

// ----------------------------------------------------------------------------
// Unknown outlet (warning, not error)
// ----------------------------------------------------------------------------

test('unknown outlet is a warning, not an error', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: 'not-a-real-outlet-xyz123',
      criticName: 'Chris Jones',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some((w) => w.check === 'unknown_outlet'));
  });
});

test('registered outlet produces no unknown_outlet warning', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(!result.warnings.some((w) => w.check === 'unknown_outlet'));
  });
});

// ----------------------------------------------------------------------------
// Garbage critic names (warning, not error)
// ----------------------------------------------------------------------------

const GARBAGE_CRITIC_NAMES = [
  'Photo Credit',
  'photo by',
  'PHOTO',
  'Staff',
  'STAFF',
  '&nbsp;Name',
  'Unknown',
  'UNKNOWN',
  'Advertisement',
  'Editorial',
  '',
  '   ',
];

for (const criticName of GARBAGE_CRITIC_NAMES) {
  test(`garbage critic name ${JSON.stringify(criticName)} produces a warning, not an error`, () => {
    withTmpShowDir((dir) => {
      const filePath = writeReview(dir, 'review.json', {
        showId: 'hamilton-2015',
        outletId: KNOWN_OUTLET,
        criticName,
      });

      const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

      assert.equal(result.errors.length, 0);
      assert.ok(result.warnings.some((w) => w.check === 'garbage_critic_name'));
    });
  });
}

test('missing criticName produces a garbage_critic_name warning', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(result.warnings.some((w) => w.check === 'garbage_critic_name'));
  });
});

const VALID_CRITIC_NAMES = ['Jesse Green', 'Ben Brantley', 'Laura Collins-Hughes', "Johnny O'Sullivan Jr. III"];

for (const criticName of VALID_CRITIC_NAMES) {
  test(`valid critic name ${JSON.stringify(criticName)} produces no garbage_critic_name warning`, () => {
    withTmpShowDir((dir) => {
      const filePath = writeReview(dir, 'review.json', {
        showId: 'hamilton-2015',
        outletId: KNOWN_OUTLET,
        criticName,
      });

      const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

      assert.ok(!result.warnings.some((w) => w.check === 'garbage_critic_name'));
    });
  });
}

// ----------------------------------------------------------------------------
// Duplicate reviews
// ----------------------------------------------------------------------------

test('duplicate outlet+critic with the same URL is an error', () => {
  withTmpShowDir((dir) => {
    const seenReviews = new Map();
    const first = writeReview(dir, 'first.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.chicagotribune.com/hamilton-review',
    });
    const second = writeReview(dir, 'second.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.chicagotribune.com/hamilton-review',
    });

    const result1 = validateReviewFile(first, new Set([KNOWN_OUTLET]), seenReviews);
    assert.equal(result1.errors.length, 0);

    const result2 = validateReviewFile(second, new Set([KNOWN_OUTLET]), seenReviews);
    assert.ok(result2.errors.some((e) => e.check === 'duplicate_review'));
  });
});

test('duplicate outlet+critic with different URLs is a warning, not an error', () => {
  withTmpShowDir((dir) => {
    const seenReviews = new Map();
    const first = writeReview(dir, 'first.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.chicagotribune.com/hamilton-review-original',
    });
    const second = writeReview(dir, 'second.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.chicagotribune.com/hamilton-review-updated',
    });

    validateReviewFile(first, new Set([KNOWN_OUTLET]), seenReviews);
    const result2 = validateReviewFile(second, new Set([KNOWN_OUTLET]), seenReviews);

    assert.equal(result2.errors.length, 0);
    assert.ok(result2.warnings.some((w) => w.check === 'duplicate_review'));
  });
});

test('same critic at different outlets is not a duplicate', () => {
  withTmpShowDir((dir) => {
    const seenReviews = new Map();
    const validOutlets = new Set([KNOWN_OUTLET, 'nytimes']);
    const first = writeReview(dir, 'first.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Jesse Green',
    });
    const second = writeReview(dir, 'second.json', {
      showId: 'hamilton-2015',
      outletId: 'nytimes',
      criticName: 'Jesse Green',
    });

    const result1 = validateReviewFile(first, validOutlets, seenReviews);
    const result2 = validateReviewFile(second, validOutlets, seenReviews);

    assert.ok(!result1.errors.some((e) => e.check === 'duplicate_review'));
    assert.ok(!result2.errors.some((e) => e.check === 'duplicate_review'));
    assert.ok(!result2.warnings.some((w) => w.check === 'duplicate_review'));
  });
});

test('same outlet+critic in different show directories is not a duplicate', () => {
  const seenReviews = new Map();
  withTmpShowDir((dir1) => {
    withTmpShowDir((dir2) => {
      const first = writeReview(dir1, 'review.json', {
        showId: path.basename(dir1),
        outletId: KNOWN_OUTLET,
        criticName: 'Jesse Green',
      });
      const second = writeReview(dir2, 'review.json', {
        showId: path.basename(dir2),
        outletId: KNOWN_OUTLET,
        criticName: 'Jesse Green',
      });

      const result1 = validateReviewFile(first, new Set([KNOWN_OUTLET]), seenReviews);
      const result2 = validateReviewFile(second, new Set([KNOWN_OUTLET]), seenReviews);

      assert.ok(!result1.errors.some((e) => e.check === 'duplicate_review'));
      assert.ok(!result2.errors.some((e) => e.check === 'duplicate_review'));
      assert.ok(!result2.warnings.some((w) => w.check === 'duplicate_review'));
    });
  });
});

// ----------------------------------------------------------------------------
// Aggregator score contamination (the copied test never exercised this check)
// ----------------------------------------------------------------------------

test('aggregator scoreSource with originalScore and no humanReviewScore is contamination', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      scoreSource: 'show-score-stars',
      originalScore: '4/5',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(result.errors.some((e) => e.check === 'aggregator_contamination'));
  });
});

test('aggregator scoreSource with humanReviewScore override is not contamination', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      scoreSource: 'show-score-stars',
      originalScore: '4/5',
      humanReviewScore: 80,
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(!result.errors.some((e) => e.check === 'aggregator_contamination'));
  });
});

// ----------------------------------------------------------------------------
// Aggregator URL mismatch (the copied test never exercised this check)
// ----------------------------------------------------------------------------

test('real outlet with an aggregator-domain URL and no preservable score is a mismatch', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.show-score.com/shows/hamilton',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(result.errors.some((e) => e.check === 'aggregator_url_mismatch'));
  });
});

test('real outlet with an aggregator-domain URL but a preservable star score is not a mismatch', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      url: 'https://www.show-score.com/shows/hamilton',
      aggregatorStars: 4,
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(!result.errors.some((e) => e.check === 'aggregator_url_mismatch'));
  });
});

// ----------------------------------------------------------------------------
// Broken duplicateOf reference (the copied test never exercised this check)
// ----------------------------------------------------------------------------

test('duplicateOf pointing at a missing file is a broken_duplicate_ref error', () => {
  withTmpShowDir((dir) => {
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      duplicateOf: 'does-not-exist.json',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(result.errors.some((e) => e.check === 'broken_duplicate_ref'));
  });
});

test('duplicateOf pointing at an existing file has no broken_duplicate_ref error', () => {
  withTmpShowDir((dir) => {
    writeReview(dir, 'target.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      fullText: 'The canonical copy.',
    });
    const filePath = writeReview(dir, 'review.json', {
      showId: 'hamilton-2015',
      outletId: KNOWN_OUTLET,
      criticName: 'Chris Jones',
      duplicateOf: 'target.json',
    });

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.ok(!result.errors.some((e) => e.check === 'broken_duplicate_ref'));
    assert.equal(result.skipped, true, 'a duplicateOf file is excluded from the rebuild population');
  });
});

// ----------------------------------------------------------------------------
// Corrupt JSON
// ----------------------------------------------------------------------------

test('unparseable JSON is a json_parse error carrying the file path', () => {
  withTmpShowDir((dir) => {
    const filePath = path.join(dir, 'broken.json');
    fs.writeFileSync(filePath, '{ not valid json');

    const result = validateReviewFile(filePath, new Set([KNOWN_OUTLET]), new Map());

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].check, 'json_parse');
    assert.ok(result.errors[0].file.includes('broken.json'));
  });
});
