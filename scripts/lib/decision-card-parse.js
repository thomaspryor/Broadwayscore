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

// Linear stores markdown, so text read back carries escapes ("BRIGHTDATA\_*",
// "\~79") and wrapped links ("[claude.ai](<http://claude.ai>)") that look like
// typos in an email. Strip them; the owner reads plain words.
function cleanOwnerText(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]]+)\]\(<?[^)>\s]*>?\)/g, '$1')
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
const QUESTION_RE = /^\s*(?:#{1,6}\s+|[-*>]\s+)?\**DECISION NEEDED\**(?:\s*\([^)]*\))?\s*:\s*\**\s*(\S.*)$/i;
// "Option A - name: upside / downside", also "Option A: ...", "A) ...", "- Option A — ..."
const OPTION_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?option\s+([A-Z0-9])\s*(?:\*\*)?\s*[-–—:.)]\s*(.+)$/i;

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
  const out = { question: '', why: '', options: [], recommendation: '', defaultLine: '', context: '' };
  let inFence = false;
  for (const line of String(description || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!out.question) {
      const q = QUESTION_RE.exec(line);
      if (q) out.question = cleanOwnerText(q[1]);
      continue;
    }
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

/** The letter in "A, staged, because ..." / "Option B ..." / "A now, B later." or null. */
function recommendedKey(recommendation, options) {
  const m = /^(?:option\s+)?([A-Z0-9])\b/i.exec(String(recommendation || '').trim());
  if (!m) return null;
  const key = m[1].toUpperCase();
  return (options || []).some((o) => o.key === key) ? key : null;
}

module.exports = { cleanOwnerText, parseDecisionDescription, recommendedKey, splitOption };
