---
name: \b regex fails for show titles ending in punctuation
description: Any `\b{title}\b` pattern silently returns 0 matches when the title ends in `!`, `?`, `.`. ~90 catalogue shows affected (Schmigadoon!, Mamma Mia!, Oklahoma!, Hello Dolly!, Oh Mary!). Use `(?<![A-Za-z0-9]){title}(?![A-Za-z0-9])` instead.
type: feedback
originSessionId: b26e10ae-8a24-4c7d-baa4-a7f5408230cb
---
# `\b` boundary regex silently fails for shows with trailing punctuation

**Rule:** Never use `\b{title}\b` to count or match show-title mentions. Use `(?<![A-Za-z0-9]){title}(?![A-Za-z0-9])` (non-alphanumeric lookbehind/lookahead) instead.

**Why:** `\b` is a word ↔ non-word transition boundary. For a title ending in `!` (a non-word character) followed by a space, quote, comma, or period (also non-word), the trailing `\b` finds no word transition and returns 0 matches. ~90 catalogue shows have trailing punctuation: Schmigadoon!, Mamma Mia!, Oklahoma!, Hello, Dolly!, Oh, Mary!, Gutenberg! The Musical!, Disaster!, Fela!, Awake and Sing!, Something Rotten!, On Your Feet!, Who's Afraid of Virginia Woolf?, Is He Dead?, Dana H., etc.

The bug is **silent** — `text.match(regex)` returns `null` and the count is 0. No error, no warning. A multi-show detector tuned to flag at 7+ mentions would simply never fire on any of these shows.

**How to apply:**
- When building any case-insensitive title-matching regex, prefer `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` over `\b${escaped}\b`.
- Audit existing usages: `grep -rn "\\\\b\\$\\{.*\\}\\\\b" scripts/` finds candidates.
- The lookbehind/lookahead also handles digits cleanly (`9 to 5`, `1984`) — `\b` happens to work for these but the new form is more obviously correct.

**Origin:** Issue #316 NYer joint Schmigadoon!/Lost Boys review. Multi-show detector (`scripts/llm-scoring/multi-show-detector.ts`) returned `otherShows: []` for the Lost Boys NYer text even though `Schmigadoon!` appeared 7 times. Fixed by 83ec10e984. Regression test: `tests/unit/multi-show-detector-punct-boundary.test.mjs`.
