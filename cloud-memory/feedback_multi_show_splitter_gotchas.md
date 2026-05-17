---
name: Multi-show splitter design gotchas
description: Hard-won lessons from shipping the Vulture/NYT photo-caption-anchored multi-show roundup splitter (Notion 352637c5-416f-819c, 2026-04-30). Architectural decisions plus parent-rewrite traps.
type: feedback
originSessionId: 8d31c4f6-5711-4772-8bce-f44d0f105eeb
archived: true
---
When working on `scripts/lib/multi-show-splitter.js` or `scripts/split-multi-show-roundups.js`:

**1. Photo-credit-anchored detection beats title-anchored.**
- **Why:** title-substring matching produces false positives on common nouns ("rope tricks" matches show "Tricks", "girls' outfits" matches "Girls", "the heart of the story" matches "The Story"). Walking photo-credit markers (`Photo:` / `Credit...`) backward to a paragraph break and matching ONE show in that ≤600-char window eliminates these.
- **How to apply:** any future caption-boundary work should anchor on the photo-credit marker, not the title. The caption's structural shape (production credit → photo credit) is more reliable than any title regex.

**2. Production-credit context required around the title.**
- **Why:** even with photo-credit anchoring, "story" can match "the heart of the story" if the prior paragraph happens to have a Photo: marker close by. Title must be preceded by `\b(?:in|with|of)\s+` AND followed by either `(?:,)?\s+at\s+(?:the\s+)?[A-Z]` (venue-anchored) OR `["",'][,]?\s*[,]\s*[A-Z]` (descriptor-anchored, requires quotes).
- **How to apply:** when extending caption shapes (e.g. for Wall Street Journal, New Yorker), keep both Patterns A (venue-anchored, quotes optional) and B (descriptor-anchored, REQUIRES quotes) — never accept bare-title matches in prose.

**3. Don't emit single-word colon-stripped variants.**
- **Why:** `"Jack: A Night on the Town with John Barrymore"` was producing variant `"jack"` which false-matched the actor "Jack Holden" in the Vulture Kenrex caption. Drop the variant unless pre-colon has ≥2 words OR ≥7 chars.
- **How to apply:** see `getTitleVariants` in `scripts/lib/multi-show-splitter.js`. Same pattern likely applies to other variant generators in the codebase (e.g. `multi-show-detector.ts`, `trim-multi-show.ts`).

**4. Parent rewrite needs ALL FOUR flag transitions or rebuild skips it.**
- **Why:** v1 of `rewriteParent()` (commit f1a3a0888c) only rewrote fullText and cleared wrongShow. The trimmed parent stayed `contentTier='invalid'` from the prior rejection AND `isMultiShowReview=true` AND lacked `needsRescore=true` (because the conditional only set it when ensembleData existed). Result: rebuild ignored the parent. Fixed in 48127ed595.
- **How to apply:** parent rewrite MUST do all four:
  1. Reset `contentTier='complete'` when prior reason matched wrong-show/multi-show
  2. Clear `isMultiShowReview` (file is now single-show after trim)
  3. ALWAYS set `needsRescore=true` (trimmed text is materially new, even for previously-unscored files)
  4. Delete stale `ensembleData` / `llmScore` (computed against un-trimmed text)

**5. CV pre-pass in rebuild-all-reviews.js runs ON trimmed text.**
- **Why:** the splitter writes the parent with trimmed text + cleared rejection flags. But `rebuild-all-reviews.js`'s CV pre-pass (line ~1304-1318) re-runs content-verification on the trimmed text and CAN re-promote `wrongShow=true` if the trimmed section is still classified as feature/non-review. This is desirable — for the NYT 4-show "feature about playwrights" article, the trimmed Anonymous section was correctly re-rejected by CV.
- **How to apply:** don't try to bypass the CV pre-pass for splitter outputs. The double-classification (splitter trim + CV check) is a feature, not a bug. If a real review section is being incorrectly re-flagged, the issue is upstream in CV's prompt, not in the splitter.

**6. Multi-show splitter can write 4+ files per run — commit + push to data/review-texts IMMEDIATELY.**
- **Why:** see `feedback_data_repos_clobber_uncommitted.md`. Background sessions running `pull --rebase` over uncommitted dirty state will silently clobber edits. The splitter writes 1 parent rewrite + N children per article — large surface area for clobber.
- **How to apply:** the script's E2E sequence in its header is mandatory ordering: `--apply` → `cd data/review-texts && git add -A && git commit && git push` → only THEN trigger downstream scoring/rebuild.

**7. URL slug pre-classification is the missing safety net.**
- **Why:** Vulture's `theater-review-X-Y-Z` URL is a real review. NYT's `dinosaurs-blackout-songs-reservoir-anonymous` URL is a feature. The splitter can't tell from photo captions alone — both have caption boundaries. Currently the LLM ensemble's `not_a_review` rejection is the safety net (correctly fired on the NYT children), but it's wasteful (4 files written + rejected per feature article).
- **How to apply:** see Notion 353637c5-416f-816c (URL-slug pre-classifier follow-up). When that lands, slug classification should run BEFORE splitting.

**8. findBoldHeaderAnchors returns N anchors per match position when a show has N productions — use distinctPositions, not just distinctShows.**
- **Why:** `findBoldHeaderAnchors(text, shows)` iterates over all shows and all title variants. For a single bold header `**Miss Saigon**` at position 0, it emits one anchor for each of the 3 Miss Saigon productions in the catalogue. `distinctShows.size = 3` BUT `distinctPositions.size = 1` — only 1 actual occurrence. Checking `distinctShows.size >= 2` alone incorrectly flags the article as multi-show.
- **How to apply:** in `collect-review-texts.js` (line 5073), the guard is `distinctPositions.size >= 2 && distinctShows.size >= 2`. Any future code that consumes `findBoldHeaderAnchors` output must similarly group by position before drawing conclusions about multi-show structure. Found in corpus scan: 3 false positives in 37,507 files, all Miss Saigon variants. Fixed 2026-05-17 commit dd3a3fa9d9.

Background: full implementation context in Notion 352637c5-416f-819c (Card 5 — multi-show critic roundup parser). Live impact verified 2026-04-30: rheology-off-broadway-2026 went from 3 to 6 reviews on broadwayscorecard.com, with new T1 Vulture/Jackson McHenry at score 84 Rave.
