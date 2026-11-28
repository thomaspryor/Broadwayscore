'use strict';
/**
 * Digest condition titles (BRO-7685). Split out of check-alert-condition-absent.js
 * (BRO-8426) so send-morning-digest.js can use it without loading that script's
 * opening-night check replays, which pull npm packages the digest workflow does
 * not install (tests/unit/morning-digest-action.test.mjs walks the require graph).
 */
const { rowMatchKey } = require('./health-row-check-cmd.js');

// owner-alert-router.js decorates a condition's digest line title when it
// resurfaces or escalates, and send-morning-digest.js used to build the
// `digest-needs-you:<title>` dispatch key from that decorated title (BRO-7685).
// `stem` is the decoration's fixed lead-in, for keys clamped mid-decoration.
const DIGEST_TITLE_DECORATIONS = [
  { re: /\s*\(still open [—–-]+ [A-Z]+-\d+\)\s*$/, stem: ' (still open — ' },
  { re: /\s+[—–-]+\s+still happening after \d+ days?\s*$/, stem: ' — still happening after ' },
  { re: /\s+[—–-]+\s+escalated after \d+ notifications?\s*$/, stem: ' — escalated after ' },
];
const DIGEST_PREFIX = 'digest-needs-you:';

/** The router's own condition title, with any trailing digest decoration removed. */
function undecoratedDigestTitle(title) {
  let t = String(title == null ? '' : title);
  for (const { re } of DIGEST_TITLE_DECORATIONS) t = t.replace(re, '');
  return t.trim();
}

/**
 * Does a (possibly clamped by rowMatchKey) `digest-needs-you:` key name the
 * ledger row titled `title`? Matches the plain title, the title plus a whole
 * decoration, and, when the key was clamped, the title plus a cut-off one.
 */
function digestKeyMatchesTitle(key, title) {
  if (typeof title !== 'string' || !title.trim()) return false;
  const target = rowMatchKey(key);
  if (!target.startsWith(DIGEST_PREFIX)) return false;
  const base = rowMatchKey(DIGEST_PREFIX + title.trim());
  if (target === base) return true;
  if (rowMatchKey(DIGEST_PREFIX + undecoratedDigestTitle(target.slice(DIGEST_PREFIX.length))) === base) return true;
  // Clamped key (it cannot grow by more than the few spaces the clamp trimmed):
  // the cut may land inside a decoration.
  const clamped = rowMatchKey(target + 'x'.repeat(16)).length - target.length < 4;
  if (!clamped || !target.startsWith(base)) return false;
  const rest = target.slice(base.length);
  return DIGEST_TITLE_DECORATIONS.some(({ stem }) => stem.startsWith(rest) || rest.startsWith(stem));
}

module.exports = { undecoratedDigestTitle, digestKeyMatchesTitle, DIGEST_PREFIX, DIGEST_TITLE_DECORATIONS };
