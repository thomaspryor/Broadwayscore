# Sprint Plan: Share my theater diary (BRO-4566)

## Overview
A no-login link (`/seen/<token>`) showing the shows a user has seen, with dates and star ratings, plus an owner switch (off by default, second release) that adds written notes. Built on the live Shared Plans pieces (BRO-4481) per `docs/specs/shared-diary.md` (revised after a 6-reviewer plan review; owner decisions in its §0).

## Sprint Summary
| Sprint | Goal | Tasks | Complexity | Waits on |
|--------|------|-------|------------|----------|
| A | Database: diary shares exist, are guarded, and read safely | 5 | 3S, 2M | nothing |
| B | A friend can open `/seen/<token>` and see the diary | 9 | 5S, 4M | A; B-T7+ wait on BRO-4558 landing (PosterGridCard, Stars) |
| C | Owner shares from My Shows → Diary (dates + stars), release 1 | 6 | 3S, 3M | B; C-T4 waits on BRO-4558 |
| D | Notes switch with count + preview confirm, release 2 | 4 | 2S, 2M | C live + owner used it |

## Sprint A: database
MODEL: Opus (security-sensitive SQL).
**Demo:** SQL harness green; on the live project a test user creates a diary share, reads it by POST, GET is refused, stop → null.
**Risks:** repointing the live `plan_shares` trigger; schema verifier red between land and apply.

### Task A-T1: Generalise the SQL harness
- **Complexity:** S · **Depends on:** None · **Parallel:** Yes
- **Files:** scripts/test-plan-shares-sql.sh → scripts/test-sql-migration.sh (rename, parity path as a flag), tests/fixtures/supabase-stub.sql (reviews columns if missing), callers of the old name (grep)
- **Acceptance criteria:**
  - VERIFY: `bash scripts/test-sql-migration.sh supabase/migrations/20261001_plan_shares.sql supabase/migrations/20261002_plan_shares_refuse_get.sql tests/sql/plan-shares.test.sql` passes as before (all plans assertions)
  - VERIFY: `grep -rn test-plan-shares-sql scripts .github tests docs` returns nothing

### Task A-T2: Write the diary_shares migration
- **Complexity:** M · **Depends on:** None · **Parallel:** Yes
- **Files:** supabase/migrations/20261004_diary_shares.sql (new)
- **Description:** `share_token_guard()` (generic; repoint `plan_shares` trigger; drop `plan_shares_guard`), `diary_shares` + owner-only RLS, `rotate_diary_share_token()`, `get_shared_diary(p_token)` (read-only refusal first, NULL for bad/unknown/disabled, rows with `date_seen < current_date + 1` or NULL, `text` key only when `show_text`, trimmed + `left(…, 4000)`, order, cap 1000 + `capped`), grants, rollback header for both tables. Re-runnable.
- **Acceptance criteria:**
  - VERIFY: applies twice cleanly in the harness (idempotency step)

### Task A-T3: Write the diary SQL tests
- **Complexity:** M · **Depends on:** A-T2 · **Parallel:** No
- **Files:** tests/sql/diary-shares.test.sql (new)
- **Description:** token minted/frozen/rotated; client-chosen token ignored; RLS (other user, anon); **another user's reviews never on A's link**; grants; GET refused with 25006; future-dated rows absent; undated present; **`text` key absent when `show_text = false`** (key, not value); present and truncated when true; whitespace-only text omitted; cap + `capped`; order; `plan_shares` still guarded by `share_token_guard`.
- **Acceptance criteria:**
  - VERIFY: `bash scripts/test-sql-migration.sh supabase/migrations/20261001_plan_shares.sql supabase/migrations/20261002_plan_shares_refuse_get.sql supabase/migrations/20261004_diary_shares.sql tests/sql/diary-shares.test.sql` passes
  - VERIFY: the plans test file passes with the diary migration applied after it

### Task A-T4: Add live diary checks to the UGC round-trip
- **Complexity:** S · **Depends on:** A-T2 · **Parallel:** Yes
- **Files:** scripts/lib/diary-shares-roundtrip.mjs (new), scripts/test-ugc-roundtrip.mjs, tests/unit/diary-shares-roundtrip.test.mjs (new), tests/unit-test-manifest.txt
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/diary-shares-roundtrip.test.mjs` passes (mocked REST; each check fails on its injected bug)

### Task A-T5: Land and apply the migration
- **Complexity:** S · **Depends on:** A-T3, A-T4 · **Parallel:** No
- **Description:** land via `land/`, dispatch `apply-migration.yml` (`migration=supabase/migrations/20261004_diary_shares.sql`, `confirm=APPLY`) in the same sitting (one transaction: the plans trigger repoint and the guard DROP go together), then dispatch `test-ugc-roundtrip.yml`. Must be applied before any code that calls `get_shared_diary` lands (C-T6).
- **Acceptance criteria:**
  - VERIFY: apply run succeeds; `verify-schema.yml` green; round-trip run shows the diary checks passing

## Sprint B: friend page
MODEL: Opus.
**Demo:** `/test/seen-fixture` and a real `/seen/<token>` render the diary in grid and list, preview card works, analytics clean.
**Risks:** refactoring live plans code (regression); BRO-4558 not landed.

### Task B-T1: Move generic share plumbing to src/lib/share-links/
- **Complexity:** M · **Depends on:** None · **Parallel:** Yes
- **Files:** src/lib/share-links/{token,load,share-name}.ts (new), src/lib/shared-plans/{load,share-url}.ts (re-point), tests
- **Acceptance criteria:**
  - VERIFY: `npx tsx --test tests/unit/shared-plans-*.test.ts` passes unchanged; `npx tsc --noEmit` clean

### Task B-T2: Batch the stub lookup in a shared catalog resolver
- **Complexity:** S · **Depends on:** B-T1 · **Parallel:** No
- **Files:** src/lib/share-links/resolve.ts (new), src/lib/shared-plans/resolve-server.ts
- **Acceptance criteria:**
  - VERIFY: unit test: 5 stub ids → 1 request (`id=in.(…)`); plans resolve tests still pass

### Task B-T3: Extract renderShareCard
- **Complexity:** S · **Depends on:** B-T1 · **Parallel:** Yes
- **Files:** src/lib/share-links/og-card.tsx (new), src/lib/shared-plans/og-card.tsx
- **Acceptance criteria:**
  - VERIFY: plans preview image renders identically (byte size within 2% on the fixture); `og-images-use-inter` test passes

### Task B-T4: One PRIVATE_SHARE_PREFIXES registry
- **Complexity:** M · **Depends on:** None · **Parallel:** Yes
- **Files:** src/lib/analytics/redact-url.ts, ga-init-script.ts, leave-by-document.ts, src/components/AnalyticsWrapper.tsx, tests/unit/analytics-redaction.test.ts, tests/unit/private-share-routes.test.ts (new)
- **Acceptance criteria:**
  - VERIFY: redaction tests pass with `/seen/<token>` cases; new test walks `src/app/*/[token]` and fails if a prefix is missing (checked by temporarily removing 'plans')

### Task B-T5: PrivateShareLayout
- **Complexity:** S · **Depends on:** B-T4 · **Parallel:** No
- **Files:** src/components/PrivateShareLayout.tsx (new), src/app/plans/[token]/layout.tsx
- **Acceptance criteria:**
  - VERIFY: `curl` of `/plans/<unknown>` locally still shows noindex,nofollow + no-referrer; leave-by-document browser check passes

### Task B-T6: shared-diary select + view model
- **Complexity:** M · **Depends on:** None · **Parallel:** Yes
- **Files:** src/lib/shared-diary/{select,view-model}.ts (new), tests/unit/shared-diary-*.test.ts, tests/fixtures/shared-diary-parity.json (new)
- **Description:** "seen" = before venue-local today or undated (nowMs injected); group by year, newest first, undated last; count after resolution; title/summary strings; `capped` note.
- **Acceptance criteria:**
  - VERIFY: unit tests incl. tonight's show (excluded), yesterday (included), undated, repeat viewings, capped

### Task B-T7: /seen/[token] routes and loader
- **Complexity:** M · **Depends on:** A-T5, B-T1, B-T2, B-T5, B-T6 · **Parallel:** No
- **Files:** src/app/seen/[token]/{page,layout,not-found,error}.tsx (new), src/lib/shared-diary/load.ts (new)
- **Acceptance criteria:**
  - VERIFY: unknown token → 404 page; malformed → 404; no DB → error page with working retry; response headers no-store

### Task B-T7b: SeenView
- **Complexity:** M · **Depends on:** B-T7, **BRO-4558 landed** · **Parallel:** No
- **Files:** src/app/seen/[token]/SeenView.tsx (the grid card BRO-4558 lands in upcoming-cards.tsx (`PosterGridCard` on its branch) + `Stars` footer; `UpcomingListRow` + `Stars` extra), tests/unit-test-manifest-tsx.txt
- **Acceptance criteria:**
  - VERIFY: fixture renders year groups, undated last, empty diary message, capped note, catalog-only show links via getShowHref

### Task B-T8: Preview image for /seen
- **Complexity:** S · **Depends on:** B-T3, B-T7 · **Parallel:** No
- **Files:** src/app/seen/[token]/opengraph-image.tsx, src/lib/shared-diary/og-card.tsx
- **Acceptance criteria:**
  - VERIFY: fixture card renders a JPEG in Inter with "Tom's theater diary" + count, no note text ever (unit asserts the card input has no text field)

### Task B-T9: Fixture page and visual QA
- **Complexity:** S · **Depends on:** B-T7 · **Parallel:** No
- **Files:** src/app/test/seen-fixture/page.tsx (new)
- **Acceptance criteria:**
  - VERIFY: `node scripts/visual-qa.mjs --paths /test/seen-fixture,/test/plans-fixture …` 0 overflow at 360–1440; plans fixture unchanged; fixture covers empty, capped, undated, no-poster and long-name cases; owner approves the screenshots

## Sprint C: owner side, release 1 (dates + stars)
MODEL: Opus.
**Demo:** owner taps Share on the Diary tab, sends the link, a logged-out phone sees the diary.
**Risks:** plans sheet regression; MyShowsClient conflicts.

### Task C-T1: useShareRow (config-driven) under usePlanShare
- **Complexity:** M · **Depends on:** None · **Parallel:** Yes
- **Files:** src/hooks/useShareRow.ts (new), src/hooks/usePlanShare.ts (thin wrapper)
- **Acceptance criteria:**
  - VERIFY: `.claude/visual-qa/share-sheet-check.mjs` (plans: stop → re-share mints a new link, last-section guard) still passes

### Task C-T2: ShareLinkPanel extracted from SharePlansModal
- **Complexity:** M · **Depends on:** C-T1 · **Parallel:** No
- **Files:** src/components/user/ShareLinkPanel.tsx (new), SharePlansModal.tsx
- **Acceptance criteria:**
  - VERIFY: plans sheet screenshots before/after identical; share-sheet check passes

### Task C-T3: ShareDiaryModal (no notes switch yet)
- **Complexity:** S · **Depends on:** C-T2, A-T5 · **Parallel:** No
- **Files:** src/components/user/ShareDiaryModal.tsx (new), src/hooks/useDiaryShare.ts (new)
- **Acceptance criteria:**
  - VERIFY: mock-mode browser check: share → link, stop → re-share new link, name validation

### Task C-T4: Diary-tab Share button
- **Complexity:** S · **Depends on:** C-T3, **BRO-4558 landed** · **Parallel:** No
- **Files:** src/app/my-shows/MyShowsClient.tsx (button + modal mount only)
- **Acceptance criteria:**
  - VERIFY: My Shows mock e2e functional tests pass; Diary shows Share at 390 and 1280

### Task C-T5: Owner and viewer events
- **Complexity:** S · **Depends on:** C-T3, B-T7 · **Parallel:** Yes
- **Files:** src/lib/shared-diary/events.ts (new)
- **Acceptance criteria:**
  - VERIFY: browser check: viewed / show tapped / share enabled fire with no token-shaped strings

### Task C-T6: Land, prod smoke, owner trial
- **Complexity:** M · **Depends on:** B-T9, C-T4, C-T5 · **Parallel:** No
- **Acceptance criteria:**
  - VERIFY: prod `/seen/<unknown>` → 404 + noindex/no-referrer; robots.txt does not block `/seen/`; preview-image response headers checked; GA leak check on `/seen/<token>` clean
  - Owner trial: card goes Paused with RECHECK-AFTER until the owner confirms

## Sprint D: notes switch, release 2
MODEL: Opus.
**Demo:** owner turns on notes after seeing the count and a preview; friends see notes in list view.
**Risks:** publishing private text.

### Task D-T1: Notes switch with count + Preview confirm
- **Complexity:** M · **Depends on:** C-T6, B-T6 · **Parallel:** No
- **Note:** the preview of notes is rendered from the owner's own diary data on the client (the public RPC withholds text while the switch is off); the "N of M entries have notes" count uses `select.ts`. Confirm copy says the iPhone app's box still reads "Private Notes" until Sprint 5.
- **Files:** ShareDiaryModal.tsx, useDiaryShare.ts
- **Acceptance criteria:**
  - VERIFY: browser check: switch → confirm shows "N of M entries have notes" + Preview; cancel leaves `show_text` false

### Task D-T2: Notes in the friend page list view
- **Complexity:** S · **Depends on:** B-T7b · **Parallel:** Yes (the SQL already withholds text while the switch is off; D-T4 lands both)
- **Files:** SeenView.tsx, upcoming-cards.tsx (relax the `note` guard)
- **Acceptance criteria:**
  - VERIFY: fixture with notes: 3-line clamp + More; grid unchanged; no note text in the preview image

### Task D-T3: "Notes (shown on your diary link)" label while sharing notes
- **Complexity:** M · **Depends on:** D-T1 · **Parallel:** Yes
- **Files:** src/components/user/RatingEditor.tsx (reads the diary share state)
- **Acceptance criteria:**
  - VERIFY: editor shows "Private Notes" with no share/notes off, the new label with notes on (mock mode)

### Task D-T4: Land and manual checks
- **Complexity:** S · **Depends on:** D-T2, D-T3 · **Parallel:** No
- **Acceptance criteria:**
  - VERIFY: iMessage/WhatsApp preview carries no note text; notes off + Safari back/forward shows none after reload; owner trial

## Dependencies Graph
A-T1 → A-T3; A-T2 → A-T3 → A-T5; A-T2 → A-T4 → A-T5
B-T1 → B-T2, B-T3; B-T4 → B-T5; {B-T1, B-T2, B-T5, B-T6, BRO-4558} → B-T7 → B-T8, B-T9
C-T1 → C-T2 → C-T3 (+A-T5) → C-T4 (+BRO-4558); {B-T9, C-T4, C-T5} → C-T6 → D-T1 → D-T2, D-T3 → D-T4

## Subagent Execution Map (within one /execute-plan session)
Subagent track 1:  A-T1 → A-T2 → A-T3 → A-T5
Subagent track 2:  A-T4
Subagent track 3:  B-T1 → B-T2 → B-T3
Subagent track 4:  B-T4 → B-T5;  B-T6
Sync:              ── A-T5 applied + BRO-4558 landed ── then B-T7…, C …

**Critical path:** A-T2 → A-T3 → A-T5 → C-T3 → C-T4 → C-T6 (gated by BRO-4558 for B-T7/C-T4).
**Cross-session plan:** Session 1: Sprint A + B-T1…B-T6 (none need BRO-4558). Session 2: B-T7…B-T9 + Sprint C. Session 3: Sprint D after the owner has used release 1.

## Known Edge Cases
- Tonight's show: excluded until the venue-local day passes (owner's own Diary may still list it as Upcoming until midnight).
- Future-dated reviews: on neither link (documented).
- Repeat viewings: separate entries; the header uses the app's count rule.
- Diaries over 1,000 entries: latest 1,000 + note.
- Diary-only (catalog-less) shows: stub lookup batched; unresolvable rows dropped before counting.
- Imported notes can be long: truncated to 4,000 chars in SQL.

## Changes from Critique
See `docs/specs/shared-diary.md` §5 for the 6-reviewer plan review. Task-level review (2026-10-04): A-T1 dropped; cross-user privacy test added to A-T3; B-T7 split (routes/loader vs SeenView) and given A-T5 as a dependency; D-T1 preview source and count rule specified; D-T2 parallel; robots.txt + preview-header checks moved into C-T6; owner trial → Paused/RECHECK-AFTER; tsx manifest listed for TS test tasks.

## Key Risks
1. Private notes published by surprise → off in DB and UI, second release, count + preview confirm, relabelled box, key-absence SQL test.
2. Regression in the live plans feature from shared refactors → every refactor task's VERIFY re-runs a plans check.
3. Conflicts with BRO-4558 in MyShowsClient/upcoming-cards → only B-T7, C-T4 and D-T2 touch those, all after it lands.
