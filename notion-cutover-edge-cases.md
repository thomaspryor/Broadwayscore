# Notion → Linear cutover: edge cases found by hand (Sprint 0)

Sprint 0 exists to test the export assumptions by hand before Sprint 2 builds tooling on them.
Everything here was executed against the live Notion and Linear APIs on 2026-08-17.

## 1. `has_children` is unusable — confirmed, and worse than documented

The plan noted that `dataSources.query` returns `has_children: false` for all 4,775 pages. Hand run adds:
**`pages.retrieve` returns `has_children: undefined`** — the property is absent from that endpoint too.

There is no cheap way to ask "does this page have body content". The exporter must call
`blocks.children.list` unconditionally on every page. Confirmed on page
`3bf637c5-416f-8132-af5a-de9a5a6f7dcb`, which reports no children on both endpoints and actually has 4.

## 2. The body holds far more than the property — quantified

For that same card:

| Source | Characters |
| -- | -- |
| `Notes` property | 1,712 |
| Page body blocks | 4,573 |
| Reassembled total | 6,251 |

**73% of that card's notes live only in the body.** A property-only export keeps the 27% that fits under
`PROP_CHUNK = 1800` and silently discards the rest. 2,183 cards carry the truncation marker.

## 3. Observed nesting depth: 0

4 blocks, `heading_2` and `paragraph` only, max depth 0 — no toggles or nested lists on the sampled card.
Recursive descent is still required (depth is not knowable in advance without descending), but the recursion is
unlikely to be deep or expensive in practice.

## 4. Linear normalises markdown on ingest — byte-identity is impossible

This is the finding that changes an acceptance criterion. Round-tripping the reassembled 6,251-char body through
`issueCreate` and reading it back:

- Source 6,251 chars → Linear 6,233 chars. **Not byte-identical.**
- Linear inserts a blank line after headings (`## Problem\nThe` → `## Problem\n\nThe`) and adds ``` fences around
  indented blocks.
- After whitespace normalisation the two still differ structurally (6,059 vs 6,075 chars).

**But it is content-lossless.** Of 173 distinct tokens of 6+ characters in the source, **0** were missing from the
Linear copy.

**Consequence:** any acceptance criterion demanding "a character-level diff reports zero differences" against
Linear can never pass. The correct standard is **token-level content preservation** — every distinct long token in
the source is present in the target. The byte-identical requirement remains valid for the Notion→file export
(Sprint 2), which does not pass through Linear.

## 5. Notion comments: none found in 100 pages

An earlier audit reported "3 of 12 sampled pages have comments" and the plan carried a task to capture them.
Hand check across **100 pages** — 40 in query order plus the 60 most-recently-edited — via `comments.list`:

**0 pages with comments. 0 API errors.**

If the true incidence were the claimed 25%, observing zero in 100 is statistically impossible. That earlier claim
is refuted. Comments may exist somewhere in the remaining 4,675 pages, but they are rare enough that building for
them is not justified.

**Consequence:** comment capture drops from required to a cheap best-effort sweep that logs a count. Do not block
the export on it, and do not build comment→Linear-comment mapping.

## 6. Rate limiting: not reached

No 429 was observed across ~110 page reads plus 100 `comments.list` calls in this session, at roughly 3 requests
per second. The export's own rate-limit exposure is real but was not triggered at this volume; the fail-on-429
requirement stands as a safety net, not as an observed behaviour.

## Cleanup note
The round-trip test created a real Linear issue, `BRO-389`. It is a test artefact and is cancelled and labelled
so it never surfaces as work.
