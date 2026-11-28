'use strict';
/**
 * pull-quote-llm-gate (BRO-8334): a cheap second model call that asks whether a
 * chosen pull quote evaluates THIS show. BRO-8326's heuristic only fires on
 * positive evidence of another show; a wrong-show quote with no such evidence
 * still passed. The heuristic stays the free first pass; this runs after it.
 *
 * Pure (CLAUDE.md §15): prompt builders and the verdict parser only. The
 * extractor owns the model call, the retry and the negative-cache stamp.
 * Only a clear "no" drops a quote; "yes", "unclear" and an unparseable reply
 * keep it, so a model hiccup never costs a good quote.
 */

const GATE_SYSTEM_PROMPT = `You check one sentence picked from a theatre review. Decide whether the sentence is the critic evaluating the named production (its writing, direction, performances, design, score, or overall experience), as opposed to a sentence about a different show, a different event, or general news that shares the same article.
Answer with exactly one word: yes, no, or unclear.
- yes: the sentence is about the named production, or about its cast, creators or staging.
- no: the sentence is about a different production, person or topic.
- unclear: the sentence could belong to either, with no clear signal.`;

const CONTEXT_CHARS = 600;

function buildGateUserPrompt(showTitle, quote, sourceText) {
  const title = String(showTitle || 'this show').trim() || 'this show';
  const text = String(sourceText || '');
  let idx = quote ? text.indexOf(quote) : -1;
  // verifyInText tolerates typographic variants; fall back to the opening words so context survives.
  if (idx < 0 && quote) idx = text.indexOf(quote.slice(0, 40));
  let context = '';
  if (idx >= 0) {
    const before = text.slice(Math.max(0, idx - CONTEXT_CHARS), idx).trim();
    const after = text.slice(idx + quote.length, idx + quote.length + CONTEXT_CHARS).trim();
    context = `\nSurrounding text, for context only:\n${before ? `...${before} ` : ''}[[SENTENCE]] ${after ? `${after}...` : ''}\n`;
  }
  return `Named production: ${title}\n\nSentence:\n${quote}\n${context}\nIs the sentence evaluating ${title}? Answer yes, no, or unclear.`;
}

/** @returns {'yes'|'no'|'unclear'} anything unreadable is 'unclear' (keeps the quote). */
function parseGateVerdict(reply) {
  const m = String(reply == null ? '' : reply).trim().toLowerCase().match(/^[^a-z]*(yes|no|unclear)\b/);
  return m ? m[1] : 'unclear';
}

function gateHint(quote, showTitle) {
  const title = showTitle || 'this show';
  return `Your previous attempt ("${quote}") was judged to be about something other than ${title}. Pick a sentence where the critic is evaluating ${title} itself.`;
}

module.exports = { GATE_SYSTEM_PROMPT, buildGateUserPrompt, parseGateVerdict, gateHint };
