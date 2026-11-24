import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mayShortCircuitCollected } = require('./url-corrected-refetch.js');

const opts = { isTruncated: false, hasGarbageText: false, datelessDateRetry: false, scoredSkip: false, completeSkip: true };
const corrected = { urlCorrectedFrom: 'https://x.test/old', needsRefetch: true, manualContentTier: 'complete', contentTier: 'complete' };

// BRO-8209: a manual-entry file whose url was corrected lost its fullText but kept contentTier complete.
test('url-corrected manual-entry file with its text wiped is refetched', () => {
  assert.equal(mayShortCircuitCollected({ ...corrected }, opts), false);
  assert.equal(mayShortCircuitCollected({ ...corrected, fullText: '' }, opts), false);
});

test('url-corrected protected file that still holds text stays skipped (no paid fetch every run)', () => {
  assert.equal(mayShortCircuitCollected({ ...corrected, fullText: 'Real review text.' }, opts), true);
  assert.equal(mayShortCircuitCollected({ urlCorrectedFrom: 'https://x.test/old', needsRefetch: true, _locked: true, fullText: 'Text' }, opts), true);
});

test('an ordinary url-corrected file is always refetched and a plain complete file still skips', () => {
  assert.equal(mayShortCircuitCollected({ urlCorrectedFrom: 'https://x.test/old', needsRefetch: true, fullText: 'Text' }, opts), false);
  assert.equal(mayShortCircuitCollected({ fullText: 'Text' }, opts), true);
});
