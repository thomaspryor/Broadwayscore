---
name: VideoScore feature plan
description: "Video critic reviews via transcript sentiment; creator list, pipeline plan."
type: project
---

VideoScore: new feature to add video critic reviews to BWSC show pages.

**Why:** Broadway Ben (advisor) says ~6 TikTok/YouTube theater critics want legitimacy that Playbill/BWW won't give them. Creators would promote the site that adds them first. Solves discoverability problem (video critics get lost in meme/gossip content).

**How to apply:** This is a P1 feature. Phases: mockup (done) → manual MVP → automated pipeline → creator pages.

## Creator List (confirmed 2026-04-07)
1. Broadway Ben (@broadwayben) — TikTok 26K, advisor
2. Mickey-Jo Theatre (@mickeyjotheatre) — TikTok 17K / YouTube 80K, UK-based formal criticism ("Mighty Joe")
3. Joe Weinberg (@overthinkingtheatre) — TikTok 18K, NYC, Outer Critics Circle voter
4. Kate Reinking (@theatreislife) — TikTok 45K, regular Broadway reviewer
5. Ash Hufford (@ashleyhufford) — TikTok 77K, biggest pure theater reviewer
6. Tyler — TBD, Ben needs to share handle
7. Sweaty Oracle (@sweatyoracle) — TikTok 99K, more commentary than pure reviews — confirm with Ben

## Technical Pipeline
- Transcript extraction: Supadata Pro ($17/mo, 3K credits), covers TikTok + Instagram Reels
- Scoring: Claude prompt on transcript → 0-100 normalized score
- Data: `data/video-reviews/{show-id}/{creator-handle}.json` + `data/video-critics.json`
- UI: Purple accent (#8b5cf6) distinguishes VideoScore from gold CriticScore

## Action Items
- Send Ben the creator list for confirmation + Tyler's handle
- Mockup file: `videoscore-mockup.html` in repo root (not committed)
