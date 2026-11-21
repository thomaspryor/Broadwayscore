---
name: OB recovery failure modes when gather-reviews comes up empty
description: When running gather-reviews on an already-opened OB show with low review count, the pipeline almost never has a single root cause. Five distinct failure modes account for ~all the observed gaps. Use this list to triage instead of chasing one hypothesis.
type: feedback
originSessionId: 64cf8c86-37ad-4e32-ad67-09338030aa55
archived: true
---
# OB recovery failure modes — triage list

When a recent OB show is post-opening with a suspiciously low review count, dispatching `gather-reviews.yml -f shows={id}` will surface a mix of these five failure modes. Diagnose all five before committing to a fix; multiple usually stack.

## Why this list exists
2026-04-29/30 spent a session running gather-reviews recovery on Hamlet, The Receptionist, Music City, and Rheology. Each show looked like a different bug at first read; they were actually the same five failure modes in different proportions. Triage by checking all five before picking a fix to ship.

## The five failure modes

1. **Title ambiguity** — the show's title matches concurrent productions (Hamlet @ BAM vs. Eddie Izzard's Solo Hamlet at Greenwich House), movies/TV (The Receptionist 2018 film), or articles that just mention the title word (NYT Olivier Awards roundup).
   *Tells:* SERP results include URLs to a 2025+ article that's clearly a different production. wrongShow/wrongProduction post-fetch flagging fires correctly.
   *Fix path:* pre-fetch SERP candidate validator with cast/venue/director snippet check (shipped 2026-04-29, commit 67c1fb1600 — see `scripts/lib/serp-candidate-validator.js`).

2. **Production continuity** — the show is a re-mount, transfer, or extension of a prior run. Pipeline correctly flags older reviews as wrongProduction by publishDate-vs-openingDate, losing legitimate same-artistic-team reviews.
   *Tells:* Pre-opening-date publishDates on files; URL slugs reference the prior venue (e.g. `rheology-at-the-bushwick-starr` for a show now at Playwrights Horizons); cast/director/writer match between runs.
   *Test cases:* Rheology (Bushwick Starr 2025 → PH 2026), Sexual Misconduct of the Middle Classes (Hugh Jackman 2024 → 2026 same Audible Minetta Lane), Music City (Greif/Landau 2024 preview era).
   *Status:* Not fixed. Notion card 351637c5-416f-81fe (production continuity).

3. **Multi-show critic roundups** — Vulture/New Yorker/NYT-style omnibus articles that cover 3-5 shows in one piece. Content extracts cleanly (8000+ chars) but flagged wrongShow because the article isn't "about" any single show.
   *Tells:* URL slug contains 2+ show-name tokens (`/article/theater-review-kenrex-holden-rheology-chowdhury-chakrabort`); fullText length > 5000 with wrongShow:true.
   *Status:* Not fixed. Notion card 352637c5-416f-819c (multi-show roundup parser).

4. **Outlet-specific extractor robustness** — fetcher returns truncated or feature-shaped content (no byline, no date, mid-sentence truncation), even on a live HTTP-200 page with a real review.
   *Tells:* fetchMethod=playwright, source=show-score-playwright on a non-show-score URL, contentVerification flags "feature article" / "no byline visible" / "text truncated mid-sentence" / "no publication date metadata".
   *Status:* One known instance. Notion card 352637c5-416f-8144 (theater-scene extractor).

5. **Catalog gap** — a same-title concurrent production isn't in shows.json at all, so its reviews land but have nowhere correct to go.
   *Tells:* SERP returns reviews of a real, currently-running production (verified externally — Playbill listing, dedicated promo site) that doesn't appear in `shows.json`. Reviews end up flagged wrongProduction on a single-row catalog.
   *Status:* One known instance (Eddie Izzard's Solo Hamlet @ Greenwich House). Notion card 351637c5-416f-8128.

## Triage procedure (when a recovery sweep finishes with low uplift)
1. List every file in `data/review-texts/{showId}/` with their `wrongProduction`, `wrongShow`, `publishDate`, `url`, `fullText.length`.
2. Bucket each into the 5 modes above.
3. Sum the uplift unblocked by each mode (how many reviews would land if we fixed mode N?).
4. Fix the highest-uplift mode first. For OB shows, modes 2 + 3 typically dominate.

## What does NOT count as a failure mode
- Genuinely thin coverage (Music City had a troubled production with `Deadline` reporting "production delays and venue issues" — critics may legitimately not have reviewed it).
- Pre-opening 404s on aggregator URLs (BWW Roundup / DTLI / TB pages don't exist until reviews start dropping; this is normal).

## SERP date-ranging is working
Verified 2026-04-29: `calculateDateWindow` + `buildDateTbs` ARE wired into the primary discovery path (`scripts/collect-outlet-reviews.js` calls `serpQuery({dateRange})`). When recoveries return wrong-year content, it's title-disambiguation (mode 1) or production-continuity (mode 2), not date filtering.
