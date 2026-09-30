/**
 * BRO-4429: pick the slice of an article the Gemini non-review classifier sees.
 *
 * The old sample was always first 2000 + last 1000 chars, so a review whose
 * opening paragraphs are history/biography (NY Sun on Les Mis Arena) read as a
 * "feature", and a wayback fetch with ~5KB of homepage JSON in front (Standard
 * on Cleansed) read as news. Now: strip any leading JSON blob, then if the text
 * is long, keep the head plus windows around where the show is actually named
 * and discussed, plus the tail (where verdicts live).
 */
'use strict';

const { stripLeadingJsonBlob } = require('./content-quality');

const HEAD = 1500;
const TAIL = 1000;
const WINDOW = 700;
const MAX_WINDOWS = 2;
const FULL_LIMIT = 3000;

function showMentionOffsets(text, showTitle) {
  // Title without a trailing year/parenthetical, e.g. "Cleansed (2026)".
  const core = String(showTitle || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (core.length < 3) return [];
  const lower = text.toLowerCase();
  const offsets = [];
  let from = HEAD;
  const end = text.length - TAIL;
  while (offsets.length < MAX_WINDOWS) {
    const i = lower.indexOf(core, from);
    if (i < 0 || i >= end) break;
    offsets.push(i);
    from = i + WINDOW * 2; // next window must not overlap
  }
  return offsets;
}

function buildClassifySample(showTitle, fullText) {
  const text = stripLeadingJsonBlob(fullText || '');
  if (text.length <= FULL_LIMIT) return text;
  const parts = [text.substring(0, HEAD)];
  for (const i of showMentionOffsets(text, showTitle)) {
    const start = Math.max(HEAD, i - WINDOW / 2);
    parts.push(text.substring(start, Math.min(text.length - TAIL, start + WINDOW)));
  }
  parts.push(text.substring(text.length - TAIL));
  return parts.join('\n\n[...]\n\n');
}

module.exports = { buildClassifySample };
