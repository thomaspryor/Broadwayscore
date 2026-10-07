---
name: Show-mention heuristic must require word count, not just char count
description: "Gate on words AND chars (≥250w + ≥1500c); not chars alone."
type: feedback
originSessionId: 8a4c950a-3ec6-4d56-9a7a-77582b696569
archived: true
---
The post-scrape show-mention heuristic in `collect-review-texts.js` was firing on short paywalled excerpts (Times UK, FT, the Sun) where the lede uses a metaphorical opening that never names the show. Concretely: a Times UK Dracula review came back as ~136 words / ~720 chars beginning "Watching Cynthia Erivo in this solo rendition of Bram Stoker's novel..." The word "Dracula" never appears in the lede. The heuristic fired and nulled fullText, dropping the review from scoring even though Playwright successfully fetched the page.

**Why:** The original gate was character-only (`cleanedText.length > 500`). 136 words ≈ 720 chars > 500, so the gate fired. But 136 words is too thin to confidently say "show not mentioned" — the lede might legitimately omit the title (metaphorical, anecdotal, performance-focused opens). Critics use creative ledes; the title often appears in the headline or further down the body.

**How to apply:**
- Use `evaluateShowMentionGuard()` from `scripts/lib/review-guards.js`. It gates on BOTH `text.length >= 1500` chars AND `wordCount >= 250` words. Below that threshold the action is `'skip'` (defer to LLM verification or aggregator score, don't null fullText).
- Always pass the canonical title from `shows.json` (via `pickShowTitleForHeuristic()`) — never the showId-derived title. `dracula-west-end-2025` becomes `"dracula west end"` which the article body never uses.
- The `flag-needs-review` branch (alreadyScored review with missing title) must also REPAIR stale damage from prior runs by clearing `showNotMentioned` and restoring `fullText` from `wrongFullText`. Without this, files stay broken forever even after the gate is fixed.

**See:** Broadwayscore@e04af9865a, scripts/lib/review-guards.js evaluateShowMentionGuard, scripts/test-opening-night-fixes.js Times UK heuristic guard tests.
