'use strict';

/**
 * decision-card-parse.js (BRO-6131): turns the text of a Linear DECISION
 * NEEDED card into the pieces the morning digest shows as a readable card.
 *
 * Cards are written by sessions in a fixed shape:
 *   DECISION NEEDED: <question>
 *   Why this is your call: <reason>
 *   Option A - <name>: <upside> / <downside>
 *   Option B - <name>: <upside> / <downside>
 *   My recommendation: <X> because <Y>.
 *   Default: <what happens if the owner does not answer>.
 *
 * Pure, no I/O (CLAUDE.md rule 15): owner-decision-notify.js attaches the
 * result to each digest item and autonomous-email-render.js renders it.
 */

const { isEmptyDecisionContent } = require('./needs-you-snapshot.js');

// Shared with owner-decision-notify.js (one definition of "which line is the
// question", so the digest card and the decision email can never disagree).
// Plain, bold, bulleted, quoted, numbered or heading lines; "DECISION NEEDED
// (owner):" too.
const MARKER_RE = /^\s*(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)?\**DECISION NEEDED\**(?:\s*\([^)]*\))?\s*:\s*\**\s*(\S.*)$/i;
// BRO-6443: heading form, "## DECISION NEEDED" (optional trailing colon) with the question on the
// next non-empty line.
// Only "(owner)" may follow the words: "(none)" / "(resolved ...)" are settled stubs.
const HEADING_RE = /^\s*#{1,6}\s+\**DECISION NEEDED\**(?:\s*\(\s*owner\s*\))?\s*:?\s*\**\s*$/i;
// Stub or leftover lines a session wrote instead of deleting the block.
const SETTLED_RE = /^\s*(?:answered|resolved|decided|done|closed)\b/i;
// No line is ever this long in a real card; the cap keeps hostile text cheap to scan.
const MAX_LINE_CHARS = 4000;

function stripCode(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    out.push(line.slice(0, MAX_LINE_CHARS).replace(/`[^`]*`/g, ''));
  }
  return out;
}

// Prefix noise on the line under a heading: bullet, quote, number, checkbox, emphasis.
const HEADING_LINE_PREFIX_RE = /^\s*(?:(?:[-*>]|\d+[.)])\s+)*(?:\[[ xX]\]\s+)?(?:\*\*|__)?/;

// BRO-6443: index of the line holding the question under a "## DECISION NEEDED" heading at `i`, or -1.
// Shared with decision-reply.js so parsing and rewriting pick the same line. Structural lines (another
// heading, a rule, a table row, a card field or option, a fence) are not a question.
function headingQuestionLine(lines, i) {
  let at = i + 1;
  while (at < lines.length && !lines[at].trim()) at++;
  if (at >= lines.length) return -1;
  const line = lines[at];
  if (/^\s*(?:#{1,6}\s|[-*_]{3,}\s*$|\||```|~~~)/.test(line)) return -1;
  const bare = line.replace(HEADING_LINE_PREFIX_RE, '');
  if (OPTION_RE.test(bare) || FIELD_RES.some(([, re]) => re.test(bare))) return -1;
  return at;
}

function isPlaceholder(q) {
  return /^</.test(q) || /<(?:what|why|name|upside|downside|x|y)\b/i.test(q) || /^\.{3}$/.test(q);
}

// Linear stores a bare URL as [url](<url>) (an address as [a](<mailto:a>)).
// Collapsed back so a 220-char cap never clips a signed owner link's second
// copy mid-signature (BRO-5235), and the dedupe hash reads the same before and
// after Linear's rewrite.
function collapseSelfLinks(text) {
  return String(text || '').replace(/\[([^\]\s]{1,2048})\]\(<?(?:mailto:)?\1>?\)/g, '$1');
}

/**
 * The first REAL "DECISION NEEDED: <question>" line: placeholders, settled
 * stubs, empty content and code blocks are skipped. Full text, no length cap.
 * @returns {{question: string, lines: string[], index: number} | null}
 */
function findDecisionQuestion(description) {
  const lines = stripCode(description);
  for (let index = 0; index < lines.length; index++) {
    let m = MARKER_RE.exec(lines[index]);
    let at = index;
    if (HEADING_RE.test(lines[index])) {
      const h = headingQuestionLine(lines, index);
      if (h < 0) continue;
      at = h;
      m = MARKER_RE.exec(lines[h]) || [null, lines[h].replace(HEADING_LINE_PREFIX_RE, '')];
    }
    if (!m) continue;
    const q = collapseSelfLinks(m[1]).replace(/\*+$/, '').trim();
    if (!q || isPlaceholder(q) || isEmptyDecisionContent(q) || SETTLED_RE.test(q)) continue;
    return { question: q, lines, index: at };
  }
  return null;
}

// BRO-6166: is there a REAL "DECISION NEEDED: <content>" anywhere in the text, including inline in a
// worker's report ("Report. DECISION NEEDED: pick A or B", "DECISION NEEDED (owner): ...", or with a dash)? Same filters as findDecisionQuestion
// (code skipped, placeholders, settled stubs and empty content ignored), but not line-anchored. A bare
// mention without a colon and content ("no DECISION NEEDED here") is not a decision.
const INLINE_DECISION_RE = /DECISION NEEDED\**(?:\s*\([^)]*\))?\s*[:–—-]\s*\**\s*(\S.*)$/i;
function hasInlineDecision(text) {
  for (const line of stripCode(text)) {
    const m = INLINE_DECISION_RE.exec(line);
    if (!m) continue;
    const q = collapseSelfLinks(m[1]).replace(/\*+$/, '').trim();
    if (!q || isPlaceholder(q) || isEmptyDecisionContent(q) || SETTLED_RE.test(q)) continue;
    return true;
  }
  return false;
}

// Linear stores markdown, so text read back carries escapes ("BRIGHTDATA\_*",
// "\~79") and wrapped links ("[claude.ai](<http://claude.ai>)") that look like
// typos in an email. Strip them; the owner reads plain words.
function cleanOwnerText(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]]{1,300})\]\(<?[^)>\s]{0,2048}>?\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const FIELD_RES = [
  ['why', /^\s*why this is your call\s*:\s*(.+)$/i],
  ['recommendation', /^\s*(?:my\s+)?recommendation\s*:\s*(.+)$/i],
  ['defaultLine', /^\s*default\s*:\s*(.+)$/i],
  ['context', /^\s*context\s*:\s*(.+)$/i],
];
// "Option A - name: upside / downside", also "Option A: ...", "- Option A — ...".
// A bare "A) ..." is not matched on purpose (too easy to hit in free text); such a
// card still renders its question, why, pick and default, just without option rows.
const OPTION_RE = /^\s*(?:[-*]\s+)?\**option\s+([A-Z0-9])\**\s*[-–—:.)]\s*(.+)$/i;

// "name: upside / downside" → { name, upside, downside }. Anything that does
// not fit the shape stays whole in `name`.
function splitOption(raw) {
  const text = cleanOwnerText(raw);
  const colon = text.indexOf(': ');
  const name = colon > 0 && colon < 90 ? text.slice(0, colon) : text;
  const rest = colon > 0 && colon < 90 ? text.slice(colon + 2) : '';
  const slash = rest.indexOf(' / ');
  return {
    name,
    upside: slash > -1 ? rest.slice(0, slash).trim() : rest.trim(),
    downside: slash > -1 ? rest.slice(slash + 3).trim() : '',
  };
}

/**
 * @param {string} description the Linear card description (markdown)
 * @returns {{question: string, why: string, options: Array<{key: string, name: string, upside: string, downside: string}>,
 *            recommendation: string, defaultLine: string, context: string} | null}
 *   null when the text has no DECISION NEEDED line.
 */
function parseDecisionDescription(description) {
  const found = findDecisionQuestion(description);
  if (!found) return null;
  const out = { question: cleanOwnerText(found.question), why: '', options: [], recommendation: '', defaultLine: '', context: '' };
  for (const line of found.lines.slice(found.index + 1)) {
    const opt = OPTION_RE.exec(line);
    if (opt) {
      out.options.push({ key: opt[1].toUpperCase(), ...splitOption(opt[2]) });
      continue;
    }
    for (const [field, re] of FIELD_RES) {
      const m = re.exec(line);
      if (m && !out[field]) { out[field] = cleanOwnerText(m[1]); break; }
    }
  }
  return out.question ? out : null;
}

// Words that may follow a bare letter pick ("A now, B later", "A because ..."); anything
// else ("A staged rollout of B") reads as the article "A", not option A.
const PICK_FOLLOWERS = /^(?:now|first|then|because|since|for|only|and)\b/i;

/** The key in "A, staged, because ..." / "Option B ..." / "A now, B later." or null. */
function recommendedKey(recommendation, options) {
  const text = String(recommendation || '').trim();
  const m = /^(option\s+)?([A-Z0-9])(?=([\s,.:;\u2013\u2014-]|$))/i.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length).replace(/^\s+/, '');
  const bare = !m[1];
  const sepFollows = /^[,.:;(\u2013\u2014-]/.test(rest) || rest === '';
  if (bare && !sepFollows && !PICK_FOLLOWERS.test(rest)) return null;
  const key = m[2].toUpperCase();
  return (options || []).some((o) => o.key === key) ? key : null;
}

module.exports = {
  MARKER_RE, HEADING_RE, SETTLED_RE, headingQuestionLine, cleanOwnerText, collapseSelfLinks, findDecisionQuestion, hasInlineDecision, isPlaceholder,
  parseDecisionDescription, recommendedKey, splitOption, stripCode,
};
