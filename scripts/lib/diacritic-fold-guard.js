/**
 * The structural half of the diacritic-fold invariant (task #648).
 *
 * Every show-title matcher must fold diacritics BEFORE it strips
 * non-alphanumerics, or an accented title shreds into fragments that match
 * nothing ("Les Misérables" -> ["les","mis","rables"]). The behavioral half
 * lives in tests/unit/sibling-matchers-diacritics.test.mjs; this module is the
 * scanner that stops the class RECURRING in a new file.
 *
 * Extracted from that test file on 2026-09-15 (CLAUDE.md rule 15: the test
 * must require() the real function, never carry its own copy) so the scanner's
 * own decisions can be fed fixtures. Before the extraction nothing pinned the
 * scanner's behavior at all — the only thing exercising it was the live
 * scripts/ tree, so a change that quietly made it match NOTHING would have
 * looked like a passing test.
 *
 * Why an EXEMPTION MARKER rather than a smarter scanner (2026-09-15):
 * scripts/lib/archive-outlet-identity.js reddened main because its header
 * QUOTES the legacy shred it exists to ban, inside a `//` block, while its live
 * code calls normalizeOutlet(). Two fixes were rejected:
 *
 *   - Baselining the file. UNFOLDED_BASELINE means "known-unfolded, still to
 *     fix", so parking a CORRECT file there permanently suppresses a real
 *     future regression in it.
 *   - Stripping comment lines before scanning. Adversarial review (Codex,
 *     2026-09-15) executed counterexamples proving a line-prefix stripper is
 *     FAIL-OPEN, which is the one thing a guard must never be. Dropping every
 *     line whose first non-whitespace is a star, or a slash-star, deletes LIVE
 *     code in at least four shapes: a one-line block comment followed by real
 *     code on the same line; a block-comment CLOSING delimiter followed by real
 *     code; a generator method, which legitimately begins with a star; and a
 *     multiplication continuation line, likewise. A line beginning with a
 *     double slash is unambiguous on its own, but not inside a template
 *     literal, where such a line is data that still executes its
 *     interpolations. Each of those hides a real shred instead of reporting it.
 *
 * So the scan stays on RAW text and stays fail-closed. A file that legitimately
 * carries the pattern DECLARES itself with `// diacritic-guard-ok: <reason>` on
 * the matching line, or on the comment line DIRECTLY above it. The reason is
 * mandatory — a bare `// diacritic-guard-ok:` exempts nothing. This mirrors the
 * convention already used by this repo's other source lints
 * (`// audit-only:` in archive-outlet-identity.js, `// unbounded-fetch-ok:`,
 * `// venue-write-guard-ok:`) rather than inventing a new one.
 */

'use strict';

// The shred signature: an ASCII-only character-class filter applied to text.
// Both the a-z and a-zA-Z spellings count — a matcher that keeps uppercase
// still destroys accented letters, so the class is not narrower than /[^a-z.
// Task #790: a trailing 0-9 requirement here left NAME matchers (critic/cast
// bylines never contain digits, e.g. [^a-z ] or [^a-z\s]) completely invisible
// to this guard even though they shred accented names identically to a slug
// builder. The signature stops at the a-z(A-Z)? prefix — any ASCII-only
// character class anchored there counts, digit or no digit.
const SHRED_SIGNATURE = /\.replace\(\/\[\^a-z(A-Z)?/;

// Every fold spelling in the codebase counts: foldDiacritics (the canonical
// helper), .normalize('NFD')/.normalize("NFD") in either quote style, NFKD,
// and the \p{Diacritic}/\p{M} property escapes review-guards.js:677 uses.
// Missing a real spelling here fails CLOSED (the file looks unfolded and, if
// unbaselined, reddens CI) — noisy but never silent.
const FOLDS = /foldDiacritics|normalize\((['"])NFK?D\1\)|\\p\{(Diacritic|M)\}/;

const GUARD_OK_RE = /\/\/\s*diacritic-guard-ok:\s*\S/;
const COMMENT_ONLY_RE = /^\s*\/\//;

/**
 * findUnexemptedShredLines(contents) -> [{ line, text }]
 *
 * One entry per shred-signature line that carries no exemption marker. `line`
 * is 1-based. Scanning per-line (rather than over the whole buffer) is what
 * makes a per-match exemption possible; verified equivalent for DETECTION
 * across all 1,892 files under scripts/lib + scripts/ at origin/main
 * 6ee8da4617e — zero files differ between the per-line and whole-buffer tests,
 * because SHRED_SIGNATURE cannot span a newline.
 *
 * The marker is honored on the matching line itself, or on the line directly
 * above it ONLY if that line is comment-only. Without the comment-only
 * restriction an unrelated trailing `// diacritic-guard-ok:` on a preceding
 * line of real code would silently exempt the match below it — that is how a
 * source lint quietly goes dead (same reasoning as archive-outlet-identity.js's
 * `// audit-only:` handling).
 */
function findUnexemptedShredLines(contents) {
  const lines = String(contents).split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SHRED_SIGNATURE.test(lines[i])) continue;
    const above = i > 0 ? lines[i - 1] : '';
    const exempt = GUARD_OK_RE.test(lines[i])
      || (COMMENT_ONLY_RE.test(above) && GUARD_OK_RE.test(above));
    if (exempt) continue;
    findings.push({ line: i + 1, text: lines[i].trim() });
  }
  return findings;
}

/**
 * isUnfolded(contents) -> boolean
 *
 * True when the file carries an un-exempted shred AND no fold anywhere.
 * FOLDS is deliberately still evaluated over the WHOLE raw buffer, exactly as
 * before this refactor: a file that folds somewhere is out of scope for the
 * structural guard, and narrowing that check would newly flag files the guard
 * has always considered fixed.
 */
function isUnfolded(contents) {
  return findUnexemptedShredLines(contents).length > 0 && !FOLDS.test(contents);
}

module.exports = {
  SHRED_SIGNATURE,
  FOLDS,
  GUARD_OK_RE,
  findUnexemptedShredLines,
  isUnfolded,
};
