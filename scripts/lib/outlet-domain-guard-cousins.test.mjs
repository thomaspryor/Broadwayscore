// Task #1531 (BRO cousin of #1529, Notion 3bc637c5). outletOwnsUrlDomain() is
// coarse — it only checks bare domain ownership, so a path-split domain like
// timeout.com/london vs timeout.com/newyork is invisible to it. Task #1529
// added outletOwnsUrlDomainIgnoringPath() (path-aware) and wired it into the
// two DTLI extractors, but left two more call sites on the coarse bare
// version: gather-reviews.js's createReviewFile() domain-validation gate
// (line ~3705) and review-normalization.js's isCrossOutletUrl() (used by the
// mergeReviews cross-outlet guard). Both are fixed here to use
// outletOwnsUrlDomainIgnoringPath() instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReviewFile } = require('../gather-reviews.js');
const { isCrossOutletUrl } = require('./review-normalization.js');

const REVIEW_TEXTS_DIR = path.join(process.cwd(), 'data', 'review-texts');

function withTempShowDir(showId, fn) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });
  try {
    return fn();
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
}

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

// --- gather-reviews.js createReviewFile() domain-validation gate ---

test('createReviewFile flags timeout-labeled review whose URL is timeout.com/london as domainMismatch', () => {
  withTempShowDir('__test-odgc-gather-timeout', () => {
    const result = quiet(() => createReviewFile('__test-odgc-gather-timeout', {
      outletId: 'timeout',
      outlet: 'Time Out',
      criticName: 'Some Critic',
      url: 'https://www.timeout.com/london/theatre/some-west-end-show-review',
      source: 'serp',
    }));
    assert.equal(result, 'domainMismatch', 'path-split timeout.com/london must still be caught as a mismatch');
  });
});

test('createReviewFile still accepts telegraph-labeled review on telegraph.co.uk (no path split)', () => {
  withTempShowDir('__test-odgc-gather-telegraph', () => {
    const result = quiet(() => createReviewFile('__test-odgc-gather-telegraph', {
      outletId: 'telegraph',
      outlet: 'The Telegraph',
      criticName: 'Some Critic',
      url: 'https://www.telegraph.co.uk/theatre/what-to-see/some-show-review-a/',
      source: 'serp',
    }));
    assert.equal(result, true, 'shared bare-domain edition label must not be flagged as a mismatch');
  });
});

test('createReviewFile still accepts sunday-telegraph-labeled review on telegraph.co.uk (no path split)', () => {
  withTempShowDir('__test-odgc-gather-sunday-telegraph', () => {
    const result = quiet(() => createReviewFile('__test-odgc-gather-sunday-telegraph', {
      outletId: 'sunday-telegraph',
      outlet: 'Sunday Telegraph',
      criticName: 'Some Critic',
      url: 'https://www.telegraph.co.uk/theatre/what-to-see/some-show-review-b/',
      source: 'serp',
    }));
    assert.equal(result, true, 'shared bare-domain edition label must not be flagged as a mismatch');
  });
});

test('createReviewFile still accepts express-uk-labeled review on express.co.uk (no path split)', () => {
  withTempShowDir('__test-odgc-gather-express-uk', () => {
    const result = quiet(() => createReviewFile('__test-odgc-gather-express-uk', {
      outletId: 'express-uk',
      outlet: 'Express',
      criticName: 'Some Critic',
      url: 'https://www.express.co.uk/entertainment/theatre/some-show-review-a/',
      source: 'serp',
    }));
    assert.equal(result, true, 'shared bare-domain edition label must not be flagged as a mismatch');
  });
});

test('createReviewFile still accepts sunday-express-labeled review on express.co.uk (no path split)', () => {
  withTempShowDir('__test-odgc-gather-sunday-express', () => {
    const result = quiet(() => createReviewFile('__test-odgc-gather-sunday-express', {
      outletId: 'sunday-express',
      outlet: 'Sunday Express',
      criticName: 'Some Critic',
      url: 'https://www.express.co.uk/entertainment/theatre/some-show-review-b/',
      source: 'serp',
    }));
    assert.equal(result, true, 'shared bare-domain edition label must not be flagged as a mismatch');
  });
});

// --- review-normalization.js isCrossOutletUrl() (mergeReviews cross-outlet guard) ---

test('isCrossOutletUrl refuses a timeout-labeled URL swap onto timeout.com/london', () => {
  assert.equal(
    isCrossOutletUrl('timeout', 'https://www.timeout.com/london/theatre/some-west-end-show-review'),
    true,
    'path-split timeout.com/london must still be refused as cross-outlet'
  );
});

test('isCrossOutletUrl allows a telegraph-labeled URL swap onto telegraph.co.uk', () => {
  assert.equal(
    isCrossOutletUrl('telegraph', 'https://www.telegraph.co.uk/theatre/what-to-see/some-show-review/'),
    false,
    'shared bare-domain edition label must not be refused as cross-outlet'
  );
});

test('isCrossOutletUrl allows a sunday-telegraph-labeled URL swap onto telegraph.co.uk', () => {
  assert.equal(
    isCrossOutletUrl('sunday-telegraph', 'https://www.telegraph.co.uk/theatre/what-to-see/some-show-review/'),
    false,
    'shared bare-domain edition label must not be refused as cross-outlet'
  );
});

test('isCrossOutletUrl allows an express-uk-labeled URL swap onto express.co.uk', () => {
  assert.equal(
    isCrossOutletUrl('express-uk', 'https://www.express.co.uk/entertainment/theatre/some-show-review/'),
    false,
    'shared bare-domain edition label must not be refused as cross-outlet'
  );
});

test('isCrossOutletUrl allows a sunday-express-labeled URL swap onto express.co.uk', () => {
  assert.equal(
    isCrossOutletUrl('sunday-express', 'https://www.express.co.uk/entertainment/theatre/some-show-review/'),
    false,
    'shared bare-domain edition label must not be refused as cross-outlet'
  );
});
