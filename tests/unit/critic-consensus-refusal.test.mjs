/**
 * BRO-4869: a Critics' Take refused by Claude (empty reply, stop_reason=refusal,
 * wicked-tour-2021) is retried once with shorter, lyric-free excerpts, then the
 * old take is kept. No API key needed: the decision is pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  refusalRetryDecision,
  excerptOptionsForAttempt,
  stripQuotedLyrics,
  formatReviewExcerpts,
  REFUSAL_RETRY_EXCERPT_CHARS,
  DEFAULT_EXCERPT_CHARS,
} = require('../../scripts/lib/critic-consensus-refusal.js');

const refused = { stop_reason: 'refusal', content: [] };
const answered = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Critics adore it.' }] };

describe('refusalRetryDecision', () => {
  it('first refusal retries, second keeps the old take', () => {
    assert.equal(refusalRetryDecision(refused, 0), 'retry');
    assert.equal(refusalRetryDecision(refused, 1), 'keep-old');
    assert.equal(refusalRetryDecision(refused, 2), 'keep-old');
  });

  it('a normal reply is accepted on any attempt', () => {
    assert.equal(refusalRetryDecision(answered, 0), 'accept');
    assert.equal(refusalRetryDecision(answered, 1), 'accept');
  });

  it('a refusal carrying text is handed to the normal text checks, not retried', () => {
    assert.equal(refusalRetryDecision({ stop_reason: 'refusal', content: [{ type: 'text', text: 'I apologize' }] }, 0), 'accept');
  });

  it('an empty reply that is not a refusal is accepted so responseText raises the real error', () => {
    assert.equal(refusalRetryDecision({ stop_reason: 'max_tokens', content: [] }, 0), 'accept');
    assert.equal(refusalRetryDecision(undefined, 0), 'accept');
  });
});

describe('excerptOptionsForAttempt', () => {
  it('first attempt uses full 500-char excerpts; the retry ~250 chars without lyrics', () => {
    assert.deepEqual(excerptOptionsForAttempt(0), { excerptChars: DEFAULT_EXCERPT_CHARS, stripLyrics: false });
    assert.deepEqual(excerptOptionsForAttempt(1), { excerptChars: REFUSAL_RETRY_EXCERPT_CHARS, stripLyrics: true });
    assert.equal(REFUSAL_RETRY_EXCERPT_CHARS, 250);
  });
});

describe('stripQuotedLyrics', () => {
  it('removes long quoted passages in straight and curly quotes, keeps short titles', () => {
    const text = 'Erivo stops the show with "Defying Gravity", singing "something has changed within me, something is not the same" at full power. Later, “I’m through accepting limits cause someone says they’re so” lands too.';
    const out = stripQuotedLyrics(text);
    assert.match(out, /"Defying Gravity"/);
    assert.doesNotMatch(out, /something has changed/);
    assert.doesNotMatch(out, /accepting limits/);
    assert.match(out, /\[quote omitted\]/);
  });

  it('never strips the prose between two short quotes', () => {
    const text = '"Wicked" is a lavish, crowd-pleasing show with "Popular" as its comic peak.';
    assert.equal(stripQuotedLyrics(text), text);
    const curly = '\u201CWicked\u201D is a lavish, crowd-pleasing show with \u201CPopular\u201D as its peak, and the witch\u2019s arc lands.';
    assert.equal(stripQuotedLyrics(curly), curly);
  });

  it('drops slash-separated verse lines', () => {
    const out = stripQuotedLyrics('A strong score.\nUnlimited / my future is unlimited / and I’ve just had a vision\nThe staging is lavish.');
    assert.equal(out, 'A strong score.\nThe staging is lavish.');
  });

  it('leaves prose without quotes alone and tolerates non-strings', () => {
    assert.equal(stripQuotedLyrics("It's a lavish, crowd-pleasing staging."), "It's a lavish, crowd-pleasing staging.");
    assert.equal(stripQuotedLyrics(undefined), '');
  });
});

describe('formatReviewExcerpts', () => {
  const reviews = [{ outlet: 'Guardian', critic: 'A', score: 80, text: `${'x'.repeat(400)} "a quoted lyric line long enough to strip" ${'y'.repeat(400)}` }];

  it('retry excerpts are 250 chars and lyric-free; first-attempt excerpts are 500', () => {
    const full = formatReviewExcerpts(reviews, excerptOptionsForAttempt(0));
    const short = formatReviewExcerpts(reviews, excerptOptionsForAttempt(1));
    const body = (s) => s.split('\n').slice(1).join('\n').replace(/\.\.\.$/, '');
    assert.equal(body(full).length, 500);
    assert.equal(body(short).length, 250);
    assert.match(full, /^Review 1 \(Guardian - A, score: 80\/100\):\n/);
    const longQuote = formatReviewExcerpts([{ ...reviews[0], text: '"a quoted lyric line long enough to strip" then prose' }], excerptOptionsForAttempt(1));
    assert.doesNotMatch(longQuote, /quoted lyric/);
  });
});
