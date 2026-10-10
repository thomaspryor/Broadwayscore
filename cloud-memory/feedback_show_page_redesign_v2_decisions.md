---
name: Show page redesign v2 — decisions snapshot (2026-04-26)
description: Decisions Tom delegated to me with "use your best judgment" before he stepped away for 2h. Lists every gap surfaced + the decision I made. Use this as the canonical reference if anyone questions the redesign direction.
type: project
originSessionId: 61fd6a86-52e8-42db-99b5-38c69f558752
archived: true
---
## Context

Building the Broadway Radar–inspired show page redesign on `worktree-show-page-redesign-v2`. Mock at `~/Documents/claude-outputs/show-page-redesign-mocks/v6-real-components-full.png` was approved layout. User stepped away 2026-04-26 ~17:30 ET; said "use your best judgment" on remaining open questions.

**Why:** Avoid blocking on every micro-decision when user explicitly handed back authority. These can all be revisited if any feel wrong on review.

**How to apply:** Future sessions touching ShowHeroRedesign or related components — match these conventions unless explicitly overridden.

---

## Decisions made (binding for v2 build)

### Mobile-web vs iOS pattern differences
1. **Tap-to-rate UI** — Web: inline expansion below action buttons (matches today's `ReviewPanel`). iOS: native bottom sheet, `.medium` detent fixed (no expand-to-large; notes textarea scrolls inside).
2. **Edit pencil** — Same interaction as Rate it. Inline on web, sheet on iOS.
3. **"Also on X list" tap** — Web → `/my-shows?tab=lists&list=X`. iOS → deep-link to Lists tab.
4. **Icons** — Web inline SVGs; iOS uses `IconSymbol` (SF Symbols).

### Shared decisions
5. **Score-card tap targets** — KEEP both tappable. Critic box → `#critic-reviews` anchor. Audience box → `#audience` anchor. Maintains existing /show behavior.
6. **"Rate it again" (1 rating)** — Opens edit panel pre-filled with existing rating; saving REPLACES.
7. **"Log another viewing" (2+ ratings)** — Opens fresh panel; saving APPENDS new viewing to diary.
8. **Date format** — `Apr 10, 2026` always. Same on web + iOS. Matches existing /show convention; do not change format mid-redesign.
9. **Multi-viewing card** — Latest viewing shown highlighted; "avg ★★★★½" in foot link routing to /my-shows. Match mock exactly.
10. **Inline delete button** — REMOVED from rating card (mock has only edit pencil). Delete moves into the edit panel. NOTE: this is a regression from current /show which has hover-trash + confirm. If users complain, add it back.
11. **Closed show + already rated** — rating card renders. Tickets primary CTA hidden, secondary tickets row hidden. Want to See still functions ("wished I'd seen" semantics).
12. **"Want to See" persistence** — Persists after rating. Becomes "On your list" (gold border + filled bookmark) once watchlisted. Watchlist + rating are independent.

### Edge cases (handled without asking)
- **<3 reviews + user has rated** — Awaiting card AND user rating card both render.
- **No audience grade yet** — score row collapses to single full-width critic card.
- **TBD ScoreBadge** — replaced by full-width "Awaiting reviews" card in this hero. Small TBD badge stays in lists/cards everywhere else.

---

## Out of scope (do NOT touch in this PR)
- Audience Grade detail card, Critic Reviews list, Box Office Scorecard, Theater Scorecard, Social Buzz, Other Productions, Lottery/Rush, Discount Tickets, Showtimes — all stay as-is below the hero.
- iOS bottom tab bar — show page is stack-pushed, no overlap.
- Watchlist planned-date chip — lives in /my-shows watchlist tab only, not on show page.
- Email capture / newsletter signup component — separate, untouched.

---

## Open questions saved for Tom's return

If Tom asks "what did you not decide?" — these are deferred:
- iOS sheet expand-to-large on textarea focus (deferred: medium fixed for v1)
- Whether the gold "Get Tickets from $X" CTA should *also* show the platform name ("on TodayTix") for affiliate clarity — left as-is
- Whether to show TodayTix's "Lottery" indicator as a badge on the primary CTA when lottery active — left as separate $X Lottery pill
- Whether long Critics' Take consensus text should line-clamp with "Read more" — left full text per mock
- iOS sheet swipe-down-to-dismiss confirmation if textarea has unsaved text — left default (dismiss without confirm) for v1
