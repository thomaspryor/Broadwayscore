/**
 * notion-text-chunking.js — splits long card text into Notion-safe chunks.
 *
 * Extracted from notion-brain.js (BRO-113: 3 cards silently lost to
 * `create` calls whose --notes contained section signs, arrows, star emoji,
 * and long em-dash runs). notion-brain.js exits at require-time without
 * NOTION_API_KEY, so nothing could require() it to test this logic in
 * isolation (CLAUDE.md §15) — it now lives here, dependency-free except for
 * the shared overflow marker, and notion-brain.js requires it back.
 *
 * Root cause of the surrogate-splitting half of BRO-113: chunkText and
 * buildRichTextWithOverflow cut on a raw character-length index. A cut that
 * lands inside a UTF-16 surrogate pair (any astral emoji, e.g. the ⭐ report's
 * star) splits one code point into two lone surrogates. Lone surrogates are
 * valid JS string content but not valid UTF-8 — the HTTP layer silently
 * replaces each with U+FFFD when encoding the request body, so the payload
 * sent to Notion is quietly corrupted (never an exception, so this alone
 * would not explain a fully missing card, but it corrupts any card whose
 * notes happen to cut mid-emoji). Fixed by nudging every cut point off a
 * surrogate boundary before slicing.
 */
'use strict';

const { OVERFLOW_NOTE } = require('./overflow-marker');

const PROP_CHUNK = 1800; // safe under Notion's 2000-char property cap
const BODY_CHUNK = 1900; // safe under Notion's 2000-char rich_text object cap

// If `index` falls between the two UTF-16 code units of a surrogate pair,
// move it back one so the pair stays intact on the earlier side of the cut.
function safeCutIndex(text, index) {
  if (index > 0 && index < text.length) {
    const code = text.charCodeAt(index - 1);
    if (code >= 0xd800 && code <= 0xdbff) return index - 1;
  }
  return index;
}

// Break text into chunks <= size, preferring newline boundaries, never
// splitting a surrogate pair.
function chunkText(text, size) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size; // no good break — hard-cut
    cut = safeCutIndex(remaining, cut);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

// Build a rich_text property value for a field. If content is short, returns
// the property with the full value and bodyText=null. If long, returns a
// preview-plus-marker property value and the full text as bodyText for the
// caller to write via writeBodySection().
function buildRichTextWithOverflow(text) {
  const s = String(text || '');
  if (s.length <= PROP_CHUNK) {
    return {
      propertyValue: { rich_text: [{ text: { content: s } }] },
      bodyText: null,
    };
  }
  const maxPreview = PROP_CHUNK - OVERFLOW_NOTE.length - 10;
  let cut = s.lastIndexOf('\n\n', maxPreview);
  if (cut < maxPreview * 0.5) cut = s.lastIndexOf('\n', maxPreview);
  if (cut < maxPreview * 0.5) cut = maxPreview;
  cut = safeCutIndex(s, cut);
  const preview = s.slice(0, cut) + OVERFLOW_NOTE;
  return {
    propertyValue: { rich_text: [{ text: { content: preview } }] },
    bodyText: s,
  };
}

module.exports = { PROP_CHUNK, BODY_CHUNK, safeCutIndex, chunkText, buildRichTextWithOverflow };
