/**
 * filer-verify-guard.js (BRO-6691): the enricher must never swap a filer's own
 * VERIFY for an invented one.
 *
 * BRO-6585 was filed with a VERIFY naming check-opening-night-readiness.js. That
 * command was not a safe form, so enrich-card-acceptance.js drafted a
 * replacement: `node --test scripts/opening-night-reviews.test.mjs`. The path
 * was absent, but check-paths.js accepts an absent path whose parent directory
 * exists as a "to be created" artifact (card #529), so the draft armed the card
 * on a test nobody was going to write, and spliceNotes() erased the filer's
 * line. The Done gate then refused the close (own-verify-failed, NOT ON MAIN).
 *
 * The to-be-created allowance stays for cards that never carried a VERIFY of
 * their own. For a card whose filer wrote one:
 *   - a draft that names a to-be-created path is rejected (guardFilerVerify);
 *   - whatever draft is accepted, the filer's line survives as prose
 *     (preserveFilerVerify), so a human reading the card can still see it (it carries no VERIFY token, so no gate reads it).
 */
'use strict';

const { isAutoEnrichedTag } = require('./card-rearm.js');
const { VERIFY_LINE_RE } = require('./autonomous-verify-cmd.js');

const PRESERVED_PREFIX = 'Filer VERIFY (kept as written, not machine-checked): ';

// The command a VERIFY line carries: the first backticked span if there is one,
// else the text minus bold/bullet decoration and trailing prose-free backticks.
function commandOf(raw) {
  const t = String(raw).trim().replace(/^\*+\s*/, '');
  const span = /`([^`]+)`/.exec(t);
  return (span ? span[1] : t.replace(/^`+|`+$/g, '')).trim();
}

const NOT_A_COMMAND_RE = /^(owner-judgment|retracted|none|n\/a|manual|tbd)\b/i;

function withoutFences(text) {
  return String(text).replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
}

// Commands on VERIFY lines the filer wrote. Empty for an enricher-written card
// (auto-enriched label); sentinels, "none"-style placeholders and fenced
// examples are not commands.
function filerVerifyCommands(card) {
  if (!card || isAutoEnrichedTag(card.tags)) return [];
  const out = [];
  for (const m of withoutFences(card.notes || '').matchAll(VERIFY_LINE_RE)) {
    const cmd = commandOf(m[1]);
    if (!cmd || NOT_A_COMMAND_RE.test(cmd)) continue;
    out.push(cmd);
  }
  return out;
}

// null when the draft is fine; a { kind, reason } rejection for the enricher's
// retry loop when it would arm a filer's card on an invented path.
function guardFilerVerify(card, newPaths) {
  const filer = filerVerifyCommands(card);
  if (!filer.length || !newPaths || !newPaths.length) return null;
  return {
    kind: 'filer-verify-invented-path',
    reason: `the card already carries a VERIFY written by its filer (${filer[0].slice(0, 80)}); a replacement must not name a file that does not exist today (${newPaths.join(', ')}). Draft a command over paths that exist now`,
  };
}

// Re-attach the filer's VERIFY text when the splice dropped it. Plain prose, no
// backticks and no leading VERIFY: token, so no extractor mistakes it for a
// command. Inserted before the first tail line matching tailRes (the footer,
// the DECISION NEEDED block) so those stay last.
function preserveFilerVerify(card, newNotes, tailRes = []) {
  const text = String(newNotes);
  const norm = l => l.replace(/['`]/g, '').trim();
  const lines = new Set(text.split('\n').map(norm));
  const lost = filerVerifyCommands(card).filter(cmd => !lines.has(norm(cmd))
    && !text.split('\n').some(l => /^\s*(?:[-*]\s*)?(?:\*\*)?VERIFY(?:\*\*)?:/i.test(l) && norm(l).includes(norm(cmd))));
  if (!lost.length) return text;
  const block = lost.map(cmd => `${PRESERVED_PREFIX}${cmd.replace(/`/g, "'")}`).join('\n');
  const at = tailRes.map(re => re.exec(text)).filter(Boolean).reduce((m, x) => Math.min(m, x.index), Infinity);
  if (at === Infinity) return `${text.replace(/\s+$/, '')}\n\n${block}\n`;
  return `${text.slice(0, at).replace(/\s+$/, '')}\n\n${block}\n\n${text.slice(at)}`;
}

module.exports = { filerVerifyCommands, guardFilerVerify, preserveFilerVerify, PRESERVED_PREFIX };
