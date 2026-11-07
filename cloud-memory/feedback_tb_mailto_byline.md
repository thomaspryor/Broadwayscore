---
name: TB mailto-anchor byline pattern
description: Talkin' Broadway bylines wrap critic name in `<a href="mailto:...">Name</a>` after "Theatre Review by"; extractAuthorFromHtml needs a dedicated pattern or falls through to Unknown
type: feedback
originSessionId: fd335f85-c83e-41f9-a837-726e42fb744c
archived: true
---
TB review pages emit the byline as:

```html
<p>Theatre Review by <a href="mailto:hmiller@talkinbroadway.com">Howard Miller</a> - April 21, 2026</p>
```

No meta[name=author], no JSON-LD Person, no `class="byline"` — none of the generic patterns in `extractAuthorFromHtml` (`scripts/lib/content-quality.js`) fire. Pre-fix, every TB review landed with `criticName='Unknown'` and got manually renamed.

**Why:** Balusters (2026-04-21) was the second TB review this cycle to manually rename `talkinbroadway--unknown.json` → `talkinbroadway--howard-miller.json`. The "extract + test" pattern (CLAUDE.md §15) caught it properly once we added a TB-specific regex to the `bylinePatterns` array and a node:test fixture from the real HTML.

**How to apply:** When a new outlet repeatedly produces Unknown bylines, check `extractAuthorFromHtml` first — the fix is usually one regex in the array, plus a real-HTML fixture in `tests/fixtures/` and a test in `tests/unit/` that asserts the extractor returns the expected name. Register the test filename in `.github/workflows/test.yml` (unit test block around line 600). The TB pattern tolerates mailto:, bio-link, and no-anchor variants because TB has changed byline link targets over the years.
