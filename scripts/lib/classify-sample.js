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

const { stripLeadingFetchDebris } = require('./content-quality');
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

// BRO-5292: cut points snap to sentence boundaries so no sample part starts or
// ends mid-word. A sample that read "...rewriting Le\n\n[...]" made
// claude-haiku report the article "truncated mid-sentence" despite the prompt
// saying "[...]" is not truncation. SNAP_SEARCH is how far a cut may move.
// CLASSIFY_SAMPLE_SNAP=0 restores the raw cuts (for an A/B of the two).
const SNAP_SEARCH = 400;
const SAMPLE_MARKER = '\n\n[...]\n\n';

// A period after these is not a sentence end ("Mr. Sorkin", "J. Smith").
const ABBREVIATION_BEFORE = /(?:^|[^\w])(?:Mr|Mrs|Ms|Mx|Dr|St|Jr|Sr|Prof|Rev|Gen|Sen|Rep|Gov|Capt|Lt|Mt|vs|etc|No|[A-Z])$/;

/**
 * Offsets in [lo, hi] where a new sentence may begin: just after [.!?] (plus
 * any closing quotes/brackets) followed by whitespace, or just after a newline.
 * Each offset points at the whitespace, so text.substring(x, b) ends a sentence
 * and text.substring(b).trimStart() starts one.
 */
function sentenceBoundaries(text, lo, hi) {
  const from = Math.max(0, lo - 4);
  const seg = text.substring(from, Math.min(text.length, hi + 1));
  const out = [];
  const re = /[.!?]["'\u201d\u2019)\]]*(?=\s)|\n/g;
  let m;
  while ((m = re.exec(seg))) {
    if (m[0] === '.' && ABBREVIATION_BEFORE.test(text.substring(Math.max(0, from + m.index - 6), from + m.index))) continue;
    const b = from + m.index + (m[0] === '\n' ? 0 : m[0].length);
    if (b >= lo && b <= hi) out.push(b);
  }
  return out;
}

/** Latest sentence end in [max(lo, pos - SNAP_SEARCH), pos], else pos. */
function snapBack(text, pos, lo = 0) {
  const bs = sentenceBoundaries(text, Math.max(lo, pos - SNAP_SEARCH), pos);
  return bs.length ? bs[bs.length - 1] : pos;
}

/** Earliest sentence end in [pos, min(hi, pos + SNAP_SEARCH)], else pos. */
function snapForward(text, pos, hi = text.length) {
  const bs = sentenceBoundaries(text, pos, Math.min(hi, pos + SNAP_SEARCH));
  return bs.length ? bs[0] : pos;
}

/**
 * [start, end) ranges of the sample. Snapped: the head ends at a sentence end
 * (shrinks), each window widens to whole sentences (start back, end forward),
 * the tail starts at a sentence start (grows). Overlapping ranges merge, so
 * widening can never repeat text or put a marker between adjacent sentences.
 */
function sampleRanges(text, showTitle, o, snap) {
  const n = text.length;
  const tailRaw = n - o.tail;
  const headEnd = snap ? snapBack(text, o.head, Math.floor(o.head / 2)) : o.head;
  const tailStart = snap ? snapBack(text, tailRaw, headEnd) : tailRaw;
  const ranges = [[0, headEnd]];
  for (const i of showMentionOffsets(text, showTitle, o)) {
    let s = Math.max(o.head, i - Math.floor(o.window / 2));
    let e = Math.min(tailRaw, s + o.window);
    if (snap) {
      s = snapBack(text, s, headEnd);
      e = snapForward(text, e, tailStart);
    }
    if (e > s) ranges.push([s, e]);
  }
  ranges.push([tailStart, n]);
  const merged = [];
  for (const [s, e] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * @param {string} showTitle
 * @param {string} fullText
 * @param {{head?:number, tail?:number, window?:number, maxWindows?:number, fullLimit?:number, snap?:boolean}} [opts]
 * @returns {string} the whole (blob-stripped) text when it fits fullLimit, else
 *   head + mention windows + tail joined with "[...]".
 */
function buildClassifySample(showTitle, fullText, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const snap = o.snap ?? process.env.CLASSIFY_SAMPLE_SNAP !== '0';
  const text = stripLeadingFetchDebris(fullText || '');
  if (text.length <= o.fullLimit) return text;
  return sampleRanges(text, showTitle, o, snap)
    .map(([s, e]) => text.substring(s, e).trim())
    .filter(Boolean)
    .join(SAMPLE_MARKER);
}

// The verifier's issue text claiming the article stops short. Marker mentions
// are "[...]" or the single-character ellipsis form some models echo back.
const TRUNCATION_ISSUE = /\btruncat|\bcut off\b|\bcuts off\b|\bmid-?sentence\b|\bmid-?word\b|\bincomplete\b|\bbreaks? off\b|\bends? abruptly\b|\bcut short\b|\bstops? (?:mid|abruptly|short)|\bunfinished\b|\bpartial\b/i;
const MARKER_MENTION = /\[\s*(?:\.\s*\.\s*\.|\u2026)\s*\]/;

/**
 * BRO-5292: neutralize a "truncated" verdict that only cites the sample marker.
 * claude-haiku reads the "[...]" between sample parts as the article breaking
 * off, despite the prompt. When the text WAS sampled (so the model saw markers)
 * and every truncation-claiming issue quotes the marker: truncated becomes
 * false and those issues are dropped. isValid is restored only when nothing
 * else stands against the article (no remaining issue, no wrongArticle /
 * wrongProduction / isFilmTv). An issue that names truncation without the
 * marker (a real cut-off ending) keeps the verdict as it was.
 *
 * @param {{isValid?:boolean, truncated?:boolean, issues?:string[], wrongArticle?:boolean, wrongProduction?:boolean, isFilmTv?:boolean}} v
 * @param {boolean} sampled  whether the model saw a sample rather than the whole text
 * @param {string} [sourceText]  the article text; a text that already contains a bracketed ellipsis disables the carve-out
 * @returns {{applied:boolean, truncated:boolean, isValid:boolean, issues:string[], dropped:string[]}}
 */
function applySampleMarkerCarveout(v, sampled, sourceText = '') {
  const issues = Array.isArray(v.issues) ? v.issues.map(String) : [];
  const isValid = v.isValid ?? true;
  const truncated = !!v.truncated;
  const unchanged = { applied: false, truncated, isValid, issues, dropped: [] };
  if (!sampled) return unchanged;
  if (v.articleType && v.articleType !== 'review') return unchanged;
  // The article itself carries a bracketed ellipsis (WordPress excerpt stubs end "[…]"): a marker citation is ambiguous, keep the verdict.
  if (MARKER_MENTION.test(String(sourceText || ''))) return unchanged;
  const truncIssues = issues.filter((i) => TRUNCATION_ISSUE.test(i));
  if (!truncIssues.length || !truncIssues.every((i) => MARKER_MENTION.test(i))) return unchanged;
  // The real ending is the untouched tail: a text not ending on terminal punctuation is plausibly cut off for real.
  const src = String(sourceText || '').trimEnd();
  if (src && !/[.!?]["'\u201d\u2019)\]]*$/.test(src)) return unchanged;
  const kept = issues.filter((i) => !truncIssues.includes(i));
  // Another truncation claim survives (marker-free): the model still says the article is cut off.
  if (kept.some((i) => TRUNCATION_ISSUE.test(i))) return unchanged;
  const restore = !isValid && !kept.length && v.wrongArticle !== true && v.wrongProduction !== true && v.isFilmTv !== true;
  return { applied: true, truncated: false, isValid: isValid || restore, issues: kept, dropped: truncIssues };
}

/** Whether buildClassifySample would sample (rather than pass whole) this text. */
function isSampled(fullText, fullLimit = DEFAULTS.fullLimit) {
  return stripLeadingFetchDebris(fullText || '').length > fullLimit;
}

module.exports = { buildClassifySample, showMentionOffsets, sentenceBoundaries, applySampleMarkerCarveout, isSampled, SAMPLE_MARKER };
