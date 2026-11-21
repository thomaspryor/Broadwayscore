#!/usr/bin/env node
/**
 * title-overlap-check.mjs — CLI wrapper around dispatch-ledger.js's
 * titleMatchesSubject(), for callers that can't require() a CommonJS module
 * directly (task #1691: ~/.claude/hooks/exit-status-gate.sh's Gate P, a
 * Python hook that shells out to `cmux` for the same reason).
 *
 * Reuses the REAL >=20-char overlap heuristic instead of a second inline
 * copy — every other place that needs this match (bsc-next.js,
 * dispatch-guards.js) requires the module directly; this is the one seam
 * for a caller that structurally cannot.
 *
 * Usage: node title-overlap-check.mjs <subject> <workspaceTitle> [<workspaceTitle>...]
 * Exit 0 + prints "MATCH" if ANY workspaceTitle overlaps <subject>.
 * One process for all live titles (not one per title) — a Stop hook already
 * pays one `cmux` subprocess; this keeps the added cost to one more, not N.
 * Exit 1 + prints "NOMATCH" if none overlap.
 * Exit 2 + prints "ERROR: <message>" on a missing argument or a require()
 * failure. Kept DISTINCT from exit 1 on purpose: the caller (Gate P) treats
 * exit 1 as a genuine "not live" signal but must NOT treat "the checker
 * itself couldn't run" the same way — collapsing the two would turn an
 * unrelated environment problem (a moved/missing dependency, node not on
 * PATH inside whatever sandboxed the hook) into a false BLOCK of real,
 * truthful DISPATCHED: claims.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const [, , subject, ...titles] = process.argv;
if (subject === undefined || titles.length === 0) {
  console.log('ERROR: usage: title-overlap-check.mjs <subject> <workspaceTitle> [...]');
  process.exit(2);
}

let titleMatchesSubject;
let stripAutoPrefix;
try {
  ({ titleMatchesSubject } = require('./dispatch-ledger.js'));
  ({ stripAutoPrefix } = require('./workspace-naming.js'));
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  process.exit(2);
}

/**
 * titleMatchesSubject is ASYMMETRIC by design: it strips the activity-glyph and
 * auto-dispatch prefix from `title` (a raw cmux workspace title) but not from
 * `subject`, because every other caller passes a raw TASK SUBJECT there, which
 * never carries a glyph.
 *
 * Gate P is the exception, and the asymmetry made it unsatisfiable. It passes
 * the title QUOTED IN THE DISPATCHED: LINE as the subject — and Gate W requires
 * that to be the exact cmux tab title, glyphs included, because that is what the
 * owner's sidebar shows. So an auto-dispatched workspace ("🤖⚡ Data·P1: …")
 * compared a glyph-stripped live title against an unstripped claimed one and
 * could NEVER match: two byte-identical strings returned NOMATCH (verified
 * 2026-08-17). Gate W demanded the glyph; Gate P rejected it. A truthful
 * DISPATCHED: claim for any 🤖 workspace was unreportable, which is exactly the
 * false BLOCK this file's own header says must never happen.
 *
 * Fix: also try the subject normalized the same way the title already is, and
 * accept an EXACT post-normalization equality regardless of length.
 *
 * Why the exact-match arm: titleMatchesSubject enforces a >=20-char floor, so a
 * legitimately short tab ("🤖⚡ Infra·P0: CI is red") still could not claim
 * itself — the same false-block class, just rarer. A claim that is byte-identical
 * to a live title after the SAME normalization is the strongest possible
 * evidence the tab exists, so the length floor has nothing left to protect
 * against there. The floor still applies to every non-exact comparison, which is
 * what stops a few incidental characters from matching.
 *
 * Honest limit (a reviewer corrected an earlier, overconfident comment here):
 * this does NOT leave the gate exactly as strict. Normalization removes the
 * activity glyph and the "<Project>·" prefix from BOTH sides, so a claim that
 * misnames the project or model glyph — "🤖⚡ Infra·P1: …" against a live
 * "🤖🔮 Data·P1: …" — now matches. That is acceptable for what Gate P actually
 * asserts ("a workspace with this work in it is running"), but it does mean Gate
 * P no longer proves the quoted string is character-for-character some live
 * tab's title. Gate W is what enforces the exact-title rule.
 */
function normalizedSubjectVariants(s) {
  const raw = String(s || '');
  const stripped = stripAutoPrefix(raw.replace(/^[^\p{L}\p{N}[]+/u, ''));
  return stripped && stripped !== raw ? [raw, stripped] : [raw];
}

const subjects = normalizedSubjectVariants(subject);
const normalizedTitle = (t) => stripAutoPrefix(String(t || '').replace(/^[^\p{L}\p{N}[]+/u, ''));
const claimedNormalized = subjects.map(normalizedTitle);
const exactAfterNormalization = (t) => {
  const n = normalizedTitle(t);
  return n.length > 0 && claimedNormalized.includes(n);
};

if (titles.some(t => exactAfterNormalization(t) || subjects.some(s => titleMatchesSubject(t, s)))) {
  console.log('MATCH');
  process.exit(0);
}
console.log('NOMATCH');
process.exit(1);
