'use strict';

/**
 * critic-consensus-refusal.js: what generate-critic-consensus.js does when
 * Claude refuses to write a Critics' Take (BRO-4869).
 *
 * wicked-tour-2021 came back with an empty reply and stop_reason=refusal
 * (BRO-4852): the full 500-char excerpts quote song lyrics at length, which
 * trips the copyright refusal. The run errored and the take stayed at the
 * 3-review version while 33 reviews existed. Policy, kept pure here so it can
 * be tested without an API key:
 *   1. first refusal  -> retry once with ~250-char excerpts, quoted lyrics removed
 *   2. second refusal -> keep the existing take and log it (never delete it,
 *                        never write an empty one)
 */

const { finalResponseText } = require('./anthropic-response-text');

const DEFAULT_EXCERPT_CHARS = 500;
const REFUSAL_RETRY_EXCERPT_CHARS = 250;
const MAX_REFUSAL_RETRIES = 1;

/** Quoted passages this long or longer are treated as quoted lyrics/lines. */
const MIN_QUOTE_CHARS = 25;

/** Excerpt settings for attempt N (0 = first try). */
function excerptOptionsForAttempt(attempt) {
  return attempt > 0
    ? { excerptChars: REFUSAL_RETRY_EXCERPT_CHARS, stripLyrics: true }
    : { excerptChars: DEFAULT_EXCERPT_CHARS, stripLyrics: false };
}

/** True when Claude stopped with stop_reason=refusal. */
function isRefusal(message) {
  return !!message && message.stop_reason === 'refusal';
}

/**
 * Next step after a reply.
 * @param {object} message Anthropic Messages response
 * @param {number} attempt 0 for the first request, 1 for the retry
 * @returns {'accept'|'retry'|'keep-old'}
 *   accept   - use the reply (callers still validate it; an empty non-refusal reply throws there)
 *   retry    - refused on the first attempt: ask again with shorter, lyric-free excerpts
 *   keep-old - refused again: leave the stored take as it is and log it
 */
function refusalRetryDecision(message, attempt) {
  if (!isRefusal(message)) return 'accept';
  // A refusal that still carries usable text is accepted as text and goes
  // through the normal refusal-pattern check in the generator.
  if (finalResponseText(message.content).trim()) return 'accept';
  return attempt < MAX_REFUSAL_RETRIES ? 'retry' : 'keep-old';
}

/**
 * Drop quoted passages (lyrics, quoted lines) and slash-separated verse.
 * Short quotes such as a song title stay.
 */
function stripQuotedLyrics(text) {
  if (typeof text !== 'string') return '';
  // Quotes are paired left to right (each match consumes its closing mark),
  // so the prose BETWEEN two short quotes is never mistaken for a quote.
  const dropLong = (m) => (m.length - 2 >= MIN_QUOTE_CHARS ? '[quote omitted]' : m);
  return text
    // "...", “...” and ‘...’ spans (may span lines). Straight single quotes
    // are left alone: they are mostly apostrophes. ’ doubles as an apostrophe,
    // so a ‘...’ span ends at the first ’ not followed by a letter.
    .replace(/"[^"]*"/g, dropLong)
    .replace(/\u201C[^\u201D]*\u201D/g, dropLong)
    .replace(/\u2018(?:[^\u2019]|\u2019(?=[a-z]))*\u2019(?![a-z])/gi, dropLong)
    // Verse written inline with " / " line breaks: "I'm through accepting limits / 'cause someone says..."
    .split('\n')
    .filter(line => (line.match(/\s\/\s/g) || []).length < 2)
    .join('\n')
    .replace(/(\[quote omitted\]\s*){2,}/g, '[quote omitted] ');
}

/**
 * The "Review N (...)" block the consensus prompts embed.
 * @param {{outlet?: string, critic?: string, score?: number, text: string}[]} reviews
 * @param {{excerptChars?: number, stripLyrics?: boolean}} [opts]
 */
function formatReviewExcerpts(reviews, opts = {}) {
  const excerptChars = opts.excerptChars || DEFAULT_EXCERPT_CHARS;
  return (reviews || []).map((r, i) => {
    const source = opts.stripLyrics ? stripQuotedLyrics(r.text) : r.text;
    return `Review ${i + 1} (${r.outlet} - ${r.critic}, score: ${r.score}/100):\n${String(source || '').slice(0, excerptChars)}...`;
  }).join('\n\n');
}

/**
 * The request loop generate-critic-consensus.js runs, with the model call
 * injected so it can be exercised against a mock (no API key in tests).
 * @param {object} args
 * @param {(params: object) => Promise<object>} args.create anthropic.messages.create
 * @param {object[]} args.reviews generator inputs
 * @param {(excerpts: string) => string} args.buildPrompt
 * @param {object} args.params model, max_tokens, temperature
 * @param {number} [args.startAttempt] 1 = start lyric-free (a corrective retry after a refused first take)
 * @param {(message: object) => void} [args.onRetry] logged before the retry
 * @param {() => Promise<void>} [args.pause] wait before the retry
 * @returns {Promise<{outcome: 'accept'|'keep-old', message: object, excerptOpts: object, attempt: number}>}
 */
async function requestWithRefusalRetry({ create, reviews, buildPrompt, params, startAttempt = 0, onRetry = null, pause = null }) {
  for (let attempt = startAttempt; ; attempt++) {
    const excerptOpts = excerptOptionsForAttempt(attempt);
    const message = await create({
      ...params,
      messages: [{ role: 'user', content: buildPrompt(formatReviewExcerpts(reviews, excerptOpts)) }],
    });
    const decision = refusalRetryDecision(message, attempt);
    if (decision !== 'retry') return { outcome: decision, message, excerptOpts, attempt };
    if (onRetry) onRetry(message);
    if (pause) await pause();
  }
}

module.exports = {
  requestWithRefusalRetry,
  DEFAULT_EXCERPT_CHARS,
  REFUSAL_RETRY_EXCERPT_CHARS,
  MAX_REFUSAL_RETRIES,
  MIN_QUOTE_CHARS,
  excerptOptionsForAttempt,
  isRefusal,
  refusalRetryDecision,
  stripQuotedLyrics,
  formatReviewExcerpts,
};
