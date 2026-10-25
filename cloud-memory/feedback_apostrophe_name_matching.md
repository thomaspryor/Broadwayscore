---
name: Apostrophe in names breaks \b regex matching — normalize before matching
description: \bobrien\b doesn't match "O'Brien" because apostrophe creates word boundary issue. Affects any code matching director/critic/cast names against fullText. Normalize both sides identically.
archived: true
type: feedback
originSessionId: 06b1bebc-35af-4865-a244-7ceec920ae23
---
**Rule:** When matching last names (or any names containing apostrophes/hyphens) against text via `\b<name>\b` regex, normalize BOTH the search text and the target name identically: lowercase + strip `['’\-]` BEFORE running the regex.

**Why:** 2026-05-09 bug in scripts/audit-show-director-consensus.js. Initial pass flagged carousel-2018 as having 0/51 reviews mention "Jack O'Brien" — but spot-check showed 47/51 reviews DO mention him. Root cause: `\b` is a word/non-word boundary. In "O'Brien", the `'` is non-word, so `\bobrien\b` looks for `obrien` as a complete word, finds the substring "Brien" instead (preceded by non-word `'`, followed by non-word). The full last name "obrien" never matches because the apostrophe splits it.

This is a SILENT data-quality false positive — the audit reported a fix was needed when shows.json was actually correct. Could have led to bad shows.json edits if not caught.

**How to apply:** Pattern is `const norm = s => s.toLowerCase().replace(/['’\-]/g, ''); const re = new RegExp('\\b' + norm(name) + '\\b', 'gi'); re.test(norm(text))`. Use BOTH sides — normalizing only one side doesn't help.

**Other affected name classes:**
- Hyphenated: "Pérusse-D'Aoste", "Lloyd-Webber"
- Mac/Mc with capitalization: "MacKinnon" (this works without normalization, but case matters)
- Curly vs straight quotes: `'` vs `’` — strip both

**Existing affected code (audit when touching):** scripts/lib/review-guards.js (hasNamedDifferentDirectorSignal uses `\b<name>\b` against fullText), scripts/lib/title-match.js (uses normalizeTitle which is similar).
