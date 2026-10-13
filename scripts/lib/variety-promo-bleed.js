'use strict';

/**
 * Variety promo bleed in stored plain text (BRO-5254).
 *
 * Before BRO-5222 wired extractVarietyBody (article-extractor.js) into the
 * collector, Variety pages went through generic paragraph extraction, which
 * kept the mid-article promo modules: an `injected-related-story` block
 * ("Related Stories" + one or two headlines or a video caption) and a
 * `pmc-contextual-player` block ("Popular on Variety"). In stored text the
 * marker sits on its own line, usually followed by whitespace-only lines and
 * sometimes by headline lines, then the review prose resumes. ~550 of ~1130
 * stored Variety texts carried it, and they were scored with it.
 *
 * This removes the marker line and the non-prose lines after it, up to the
 * next prose line. It refuses (and the caller sends the row to a refetch)
 * when the block looks unlike that shape, the text is one flat line of page
 * chrome, or what remains is too short to be a whole review.
 */

const MARKER_LINE_RE = /^\s*(Related Stories|Popular on Variety)\s*$/i;
// Flat (no line breaks) page chrome still names the module inline.
const FLAT_MARKER_RE = /\b(Related Stories|Popular on Variety)\b/i;
// A marker that starts a line but has text after it on the same line.
const INLINE_MARKER_RE = /(^|\n)[^\S\n]*(Related Stories|Popular on Variety)\b/;
// A whole Variety review is ~3-9K chars; a lede plus promo is ~600-840
// (the 2026-05-29 truncation incident). Below this, strip would leave a
// fragment that then gets scored as the whole review: refetch instead.
const MIN_CLEAN_LENGTH = 1500;
const MAX_REMOVED_RATIO = 0.2;
// Headlines and captions between the marker and the prose.
const MAX_BLOCK_LINES = 6;
// A Title Case line this short that ends like a sentence could be a headline
// ending in "?" or a cast sentence ("Sutton Foster and Hugh Jackman lead the
// cast."); neither guess is safe, so the row goes to a refetch.
const AMBIGUOUS_LINE_CHARS = 160;
const MAX_BLOCK_CHARS = 600;
const RESCORE_REASON = 'variety-promo-bleed (BRO-5254)';

function isTitleCase(t) {
  const words = t.split(/\s+/).filter(w => /^[A-Za-z][A-Za-z'’-]{3,}/.test(w));
  if (words.length < 3) return false;
  const caps = words.filter(w => /^[A-Z]/.test(w)).length;
  return caps / words.length >= 0.6;
}

/**
 * Review prose (stop line), as opposed to a headline or video caption. Any line
 * that ends like a sentence or clause counts as prose, so a real sentence is
 * never removed; Variety's injected headlines and captions carry no end mark.
 */
function isProseLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.length >= 200) return true;
  return /[.!?…:;,]["”’'»)\]]*$/.test(t);
}

/**
 * Promo blocks in `text`: [{ start, end, marker, lines }] where text.slice(start, end)
 * is the marker line plus the non-prose lines after it. `unsafe` is set when the
 * lines after the marker are more than a headline or two.
 */
function findVarietyPromoBleed(text) {
  if (typeof text !== 'string' || !text) return [];
  const blocks = [];
  const lines = text.split('\n');
  const offsets = [];
  let pos = 0;
  for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_LINE_RE);
    if (!m) continue;
    let j = i + 1;
    const between = [];
    while (j < lines.length && !isProseLine(lines[j])) {
      // A second marker right after the first is the same block.
      if (lines[j].trim()) between.push(lines[j].trim());
      j++;
    }
    const content = between.filter(t => !MARKER_LINE_RE.test(t));
    const chars = content.reduce((s, t) => s + t.length, 0);
    blocks.push({
      start: offsets[i],
      end: j < lines.length ? offsets[j] : text.length,
      marker: m[1],
      lines: content,
      unsafe: content.length > MAX_BLOCK_LINES || chars > MAX_BLOCK_CHARS || j >= lines.length
        || (lines[j].trim().length < AMBIGUOUS_LINE_CHARS && isTitleCase(lines[j].trim())),
    });
    i = j - 1;
  }
  return blocks;
}

/** True when the text still carries a promo block (line-level or flat chrome). */
function hasVarietyPromoBleed(text) {
  if (typeof text !== 'string' || !text) return false;
  if (findVarietyPromoBleed(text).length) return true;
  if (INLINE_MARKER_RE.test(text)) return true;
  return !text.includes('\n') && FLAT_MARKER_RE.test(text);
}

// Some stored texts start with the review's excerpt and then the full body,
// whose first paragraph is the same text: an exact repeat of the lead.
const PARA_BREAK_RE = /\n[^\S\n]*\n\s*/;
const MIN_DUP_LEAD_CHARS = 80;
const normPara = (t) => t.replace(/\s+/g, ' ').trim();

/** Index where the second paragraph starts when paragraph 1 repeats exactly as paragraph 2, else -1. */
function duplicatedLeadEnd(text) {
  if (typeof text !== 'string') return -1;
  const t = text.replace(/^\s+/, '');
  const m1 = t.match(PARA_BREAK_RE);
  if (!m1) return -1;
  const p1 = normPara(t.slice(0, m1.index));
  const rest = t.slice(m1.index + m1[0].length);
  const m2 = rest.match(PARA_BREAK_RE);
  if (!m2) return -1; // the "repeat" would be the whole rest of the text
  const p2 = normPara(rest.slice(0, m2.index));
  if (p1.length < MIN_DUP_LEAD_CHARS || p1 !== p2) return -1;
  return text.length - rest.length;
}

function hasDuplicatedLead(text) { return duplicatedLeadEnd(text) >= 0; }

/** Text without the repeated lead paragraph (unchanged when there is none). */
function dropDuplicatedLead(text) {
  const i = duplicatedLeadEnd(text);
  return i < 0 ? text : text.slice(i);
}

/**
 * { text, blocks, refused } — text is the cleaned text when refused is null.
 * refused names why the row needs a refetch instead.
 */
function stripVarietyPromoBleed(text) {
  if (typeof text !== 'string' || !text) return { text, blocks: [], refused: 'no text' };
  const blocks = findVarietyPromoBleed(text);
  if (!blocks.length) {
    if (!hasVarietyPromoBleed(text)) return { text: dropDuplicatedLead(text), blocks, refused: null };
    return { text, blocks, refused: text.includes('\n') ? 'marker inline with text' : 'flat page chrome' };
  }
  if (blocks.some(b => b.unsafe)) return { text, blocks, refused: 'block is not a short headline run' };
  let out = '';
  let last = 0;
  for (const b of blocks) {
    out += text.slice(last, b.start).replace(/\s+$/, '');
    out += '\n\n';
    last = b.end;
  }
  out += text.slice(last).replace(/^\s+/, '');
  out = out.replace(/^\s+/, '').replace(/\s+$/, '');
  if (hasVarietyPromoBleed(out)) return { text, blocks, refused: 'marker left after strip' };
  if (out.length < MIN_CLEAN_LENGTH) return { text, blocks, refused: `too short after strip (${out.length})` };
  // Whitespace runs are most of a block; measure the removed non-space chars.
  const solid = (s) => s.replace(/\s+/g, '').length;
  if (solid(text) - solid(out) > solid(text) * MAX_REMOVED_RATIO) {
    return { text, blocks, refused: 'strip would remove over 20% of the text' };
  }
  return { text: dropDuplicatedLead(out), blocks, refused: null };
}

/**
 * Apply an accepted strip: new fullText, rescore queued (the score was computed
 * on text with the promo lines), pre-strip score kept for the A/B, pull quote
 * dropped when no longer in the text. Returns a new object.
 */
function applyVarietyPromoStrip(record, newText, { at } = {}) {
  const out = { ...record };
  const stamp = at || new Date().toISOString();
  const previousLength = (record.fullText || '').length;
  out.fullText = newText;
  const wc = newText.split(/\s+/).filter(Boolean).length;
  if ('textWordCount' in out) out.textWordCount = wc;
  if ('wordCount' in out) out.wordCount = wc;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  if (out.llmPullQuote && !norm(newText).includes(norm(out.llmPullQuote))) out.llmPullQuote = null;
  out.needsRescore = true;
  out.rescoreReason = RESCORE_REASON;
  require('./rescore-lifecycle').markRescoreFlagged(out, stamp);
  delete out.rescoreCompletedAt;
  // Push restore must not read the old (longer) copy as richer text (review-write-guard _deliberateTextTrim).
  out.fullTextTrimmed = { reason: RESCORE_REASON, fromLength: previousLength, toLength: newText.length, at: stamp };
  // A second strip (a refetch brought a marker back, or a duplicated lead) keeps the
  // first baseline score; newLength follows the text so restoreBigMove can tell a
  // rescore of this text from one of a later refetch.
  out.varietyPromoStrip = record.varietyPromoStrip ? { ...record.varietyPromoStrip, newLength: newText.length } : {
    at: stamp,
    previousLength,
    newLength: newText.length,
    previousScore: typeof record.assignedScore === 'number' ? record.assignedScore : null,
    previousBucket: (record.llmScore && record.llmScore.bucket) || null,
    previousScoredAt: (record.llmMetadata && record.llmMetadata.scoredAt) || null,
  };
  return out;
}

// The strip removes no review content, so a rescore that moves a row this far
// (or across a bucket) is ensemble noise: keep the pre-strip score.
const BIG_MOVE_POINTS = 5;

/**
 * Rescored after a strip and moved BIG_MOVE_POINTS+ or changed bucket: returns the
 * record with the pre-strip llmScore score/bucket back (the rebuild reads llmScore)
 * and the rescore kept in varietyPromoStrip.restored. Otherwise null.
 */
function restoreBigMove(record, { at } = {}) {
  const s = record && record.varietyPromoStrip;
  const llm = record && record.llmScore;
  const scoredAt = record && record.llmMetadata && record.llmMetadata.scoredAt;
  // No previous bucket: the baseline may be a non-LLM score (assignedScore is a rebuild output).
  if (!s || typeof s.previousScore !== 'number' || !s.previousBucket || !llm || typeof llm.score !== 'number') return null;
  if (record.needsRescore || !scoredAt || scoredAt === s.previousScoredAt) return null;
  // Text changed since the strip (a refetch): the rescore is of other text, keep it.
  if (typeof record.fullText !== 'string' || record.fullText.length !== s.newLength) return null;
  if (s.restored && s.restored.scoredAt === scoredAt) return null;
  const moved = Math.abs(llm.score - s.previousScore) >= BIG_MOVE_POINTS
    || (!!llm.bucket && llm.bucket !== s.previousBucket);
  if (!moved) return null;
  const out = { ...record };
  out.llmScore = { ...llm, score: s.previousScore, bucket: s.previousBucket };
  out.assignedScore = s.previousScore;
  out.varietyPromoStrip = {
    ...s,
    restored: { at: at || new Date().toISOString(), scoredAt, rescoredScore: llm.score, rescoredBucket: llm.bucket || null },
  };
  return out;
}

/** Rows the rebuild leaves out anyway (no live score): not worth a strip, a rescore or a place in the A/B. */
function isExcludedRow(d) {
  if (!d) return false;
  // Mirrors the scorer's dataQualitySkipped reasons (scripts/llm-scoring/index.ts), stale roundup flags included.
  const roundup = d.isRoundupArticle && !require('./review-guards').isLikelyStaleRoundupFlag(d);
  return !!(d.wrongShow || d.wrongProduction || d.wrongAttribution || d.duplicateOf || d.isNonReview || roundup
    || d.rejectionReason || d.fabricatedEntry || d.contentTier === 'invalid');
}

module.exports = {
  findVarietyPromoBleed, hasVarietyPromoBleed, stripVarietyPromoBleed, applyVarietyPromoStrip,
  hasDuplicatedLead, dropDuplicatedLead, restoreBigMove,
  isProseLine, isExcludedRow, RESCORE_REASON, MIN_CLEAN_LENGTH, BIG_MOVE_POINTS,
};
