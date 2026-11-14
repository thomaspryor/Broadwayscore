import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessFullText, getBestTextForScoring } = require('../../scripts/lib/text-quality.js');

const BODY = 'Slam Frank is a bucking bronco in a world of pony rides. '.repeat(30)
  + 'But if you can hang on till the end, you might find that getting knocked around can jostle new things loose.';

// Real shapes seen on 2026-10-06 (BRO-4804): footers with no final punctuation.
const FOOTERS = [
  ' Add as a preferred source on Google',
  ' Email this Story Print this Story Leave a comment',
  ' Sign in to post a comment. Comments',
];

test('a complete review followed by a page footer is NOT truncated when contentTier is complete (BRO-4804, Slam Frank TheaterMania)', () => {
  for (const f of FOOTERS) {
    assert.equal(assessFullText(BODY + f, true, { trustedComplete: true }), 'complete', f);
    const r = getBestTextForScoring({ fullText: BODY + f, contentTier: 'complete' });
    assert.equal(r.status, 'complete', f);
  }
});

test('without the tier signal the old behaviour is unchanged (footer still reads truncated)', () => {
  for (const f of FOOTERS.filter(f => !/preferred source/.test(f))) {
    assert.equal(assessFullText(BODY + f), 'truncated', f);
    assert.equal(getBestTextForScoring({ fullText: BODY + f }).status, 'truncated', f);
    assert.equal(getBestTextForScoring({ fullText: BODY + f, contentTier: 'truncated' }).status, 'truncated', f);
  }
});

test('the TheaterMania footer line is stripped from the text the models see (OpenAI read it as a cut-off even without the warning)', () => {
  const r = getBestTextForScoring({ fullText: BODY + '\nAdd as a preferred source on Google', contentTier: 'complete' });
  assert.ok(!/preferred source/i.test(r.text), r.text.slice(-60));
  assert.equal(r.status, 'complete');
});

test('a clean ending is complete either way', () => {
  assert.equal(assessFullText(BODY), 'complete');
  assert.equal(assessFullText(BODY, true, { trustedComplete: true }), 'complete');
});

test('trusting the tier never hides paywall wording, an ellipsis cut, or a bot-wall stub', () => {
  for (const tail of [' Subscribe to continue reading', ' Continue reading', ' To read the full review, sign in to continue...', ' Advertisement']) {
    assert.equal(assessFullText(BODY + tail, true, { trustedComplete: true }), 'truncated', tail);
    assert.equal(getBestTextForScoring({ fullText: BODY + tail, contentTier: 'complete' }).status, 'truncated', tail);
  }
});
