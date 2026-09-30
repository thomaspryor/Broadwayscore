/**
 * BRO-4429: pick the slice of an article an LLM classifier sees.
 *
 * The old sample was always first 2000 + last 1000 chars, so a review whose
 * opening paragraphs are history/biography (NY Sun on Les Mis Arena) read as a
 * "feature", and a wayback fetch with ~5KB of homepage JSON in front (Standard
 * on Cleansed) read as news. Now: strip any leading JSON blob, then if the text
 * is long, keep the head plus windows around where the show is actually named
 * and discussed, plus the tail (where verdicts live).
 *
 * Mentions are found through show-title-variants, so a shows.json title with a
 * subtitle or accents ("Les Misérables: The Arena Concert Spectacular") still
 * matches the "Les Miserables" the critic wrote. Used by the Gemini non-review
 * pass (defaults), the content verifier and the wrong-show / wrong-production
 * classifiers (their own sizes via opts).
 */
'use strict';

const { stripLeadingJsonBlob } = require('./content-quality');
const { normalizeForMention, buildShowTitleVariants, findVariantSpans } = require('./show-title-variants');

const DEFAULTS = { head: 1500, tail: 1000, window: 700, maxWindows: 2, fullLimit: 3000 };
const MIN_VARIANT_LENGTH = 4;

/**
 * Raw-text offsets where the show is named, between head and tail, at most
 * maxWindows of them and spread across that span (the earliest few of an
 * often-named title would all sit just after the head). Variant spans are
 * offsets into normalizeForMention() text, which differs in length from the raw
 * text, so they are mapped back proportionally; the window is wide enough to
 * absorb the drift.
 */
function showMentionOffsets(text, showTitle, o = DEFAULTS) {
  const norm = normalizeForMention(text);
  if (!norm || !showTitle) return [];
  const scale = text.length / norm.length;
  const start = o.head;
  const end = text.length - o.tail;
  const all = [];
  for (const v of buildShowTitleVariants(showTitle)) {
    if (v.length < MIN_VARIANT_LENGTH) continue;
    for (const [s] of findVariantSpans(norm, v)) {
      const raw = Math.round(s * scale);
      if (raw >= start && raw < end) all.push(raw);
    }
  }
  const sorted = [...new Set(all)].sort((a, b) => a - b);
  // Non-overlapping candidates, then spread picks across them.
  const spaced = [];
  for (const i of sorted) {
    if (!spaced.length || i - spaced[spaced.length - 1] >= o.window) spaced.push(i);
  }
  if (spaced.length <= o.maxWindows) return spaced;
  if (o.maxWindows === 1) return [spaced[0]];
  return [...new Set(Array.from({ length: o.maxWindows }, (_, k) =>
    spaced[Math.round((k * (spaced.length - 1)) / (o.maxWindows - 1))]))];
}

/**
 * @param {string} showTitle
 * @param {string} fullText
 * @param {{head?:number, tail?:number, window?:number, maxWindows?:number, fullLimit?:number}} [opts]
 * @returns {string} the whole (blob-stripped) text when it fits fullLimit, else
 *   head + mention windows + tail joined with "[...]".
 */
function buildClassifySample(showTitle, fullText, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const text = stripLeadingJsonBlob(fullText || '');
  if (text.length <= o.fullLimit) return text;
  const parts = [text.substring(0, o.head)];
  for (const i of showMentionOffsets(text, showTitle, o)) {
    const start = Math.max(o.head, i - Math.floor(o.window / 2));
    parts.push(text.substring(start, Math.min(text.length - o.tail, start + o.window)));
  }
  parts.push(text.substring(text.length - o.tail));
  return parts.join('\n\n[...]\n\n');
}

module.exports = { buildClassifySample, showMentionOffsets };
