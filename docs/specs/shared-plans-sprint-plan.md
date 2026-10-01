# Sprint Plan: Share My Theater Plans (BRO-4481)

## Overview
A live, login-free link (`/plans/<token>`) that shows a user's booked shows (date only) and their not-yet-booked watchlist, shared from a share sheet on web and iOS. Spec and reviewed technical plan: `docs/specs/shared-plans.md`. Per-show hiding is V2 (owner, 2026-10-01).

Environment facts checked while planning: the cloud sandbox has PostgreSQL 16 and Docker, so SQL is tested locally first; the live-database check extends the existing `scripts/test-ugc-roundtrip.mjs` (no workflow edit needed); the iOS repo is public and readable, and pushing to it needs `add_repo` with push access.

Roadmap check: the roadmap lives in `thomaspryor/broadway-scorecard-data` issue 1, which is outside this session's repository scope; no overlap found in Linear (`linear-brain.js find` for "share watchlist" / "shared plans" returned nothing). Related, not blocking: `docs/specs/diary-sharing-and-calendar.md`.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 1 | Database live: share table, guard trigger, public read function, tested locally and on prod | 5 | 2S, 3M |
| 2 | A hand-made share renders at `/plans/<token>` with posters, calendar adds and a preview card | 9 | 4S, 5M |
| 3 | The token never reaches analytics tools | 3 | 1S, 2M |
| 4 | Owner can create and share their link from the web (demo site); real trial with the partner | 6 | 3S, 3M |
| 5 | Owner can share from the iOS app; released behind a flag, then switched on | 6 | 3S, 3M |
| 6 | Close-out | 2 | 2S |

## Sprint 1: Database
MODEL: Opus. Security-sensitive SQL (SECURITY DEFINER, RLS, grants).
**Demo:** `psql` against a local Postgres shows a share created for a fixture user, `get_shared_plans(token)` returning only allowed fields, and every refusal case returning NULL. Then the same checks pass against the live project.
**Risks:** Supabase-specific behaviour (role grants, `auth.uid()`, `gen_random_uuid` availability) differs from plain Postgres; the schema verifier goes red between landing the file and applying it.

### Task S1-T1: Build a local Postgres harness that mimics Supabase roles
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes (with S1-T2)
- **Files:** `scripts/test-plan-shares-sql.sh` (new), `tests/fixtures/supabase-stub.sql` (new)
- **Description:** Starts a throwaway Postgres 16 cluster in the scratch dir, creates `anon`/`authenticated` roles, an `auth.uid()` that reads a session setting, and minimal `profiles`/`watchlist`/`reviews` tables copied from `supabase-schema.sql` and `20260809_watchlist_showtime.sql`. Runs a given SQL file plus a test file and exits non-zero on any failed assertion.
- **Acceptance criteria:**
  - VERIFY: `bash scripts/test-plan-shares-sql.sh --self-test` exits 0 and prints a passing trivial assertion
  - VERIFY: `bash scripts/test-plan-shares-sql.sh --self-test` with a deliberately false assertion exits 1

### Task S1-T2: Write the shared bucket-parity fixture
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `tests/fixtures/shared-plans-parity.json` (new)
- **Description:** One JSON file of watchlist rows + review dates + a "today" per market, with the expected booked / want-to-see / excluded result for each row (future, today, past-unlogged, past-logged, re-booked after a review, undated review, closed show, West End across the UK clock change). Web, SQL and iOS tests all read it.
- **Acceptance criteria:**
  - VERIFY: `node -e "JSON.parse(require('fs').readFileSync('tests/fixtures/shared-plans-parity.json'))"` exits 0
  - VERIFY: each case has `input` and `expected`, and every bucket appears at least once (checked by a one-line node assertion in the task)

### Task S1-T3: Write the plan_shares migration
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** `supabase/migrations/20261001_plan_shares.sql` (new), `tests/sql/plan-shares.test.sql` (new)
- **Description:** Table, owner-only RLS, `plan_shares_guard` trigger (token minted on insert, frozen on update unless rotating, trims name, bumps updated_at), `rotate_plan_share_token()`, `get_shared_plans(p_token)`, and the REVOKE/GRANT block, exactly per spec §3.1–3.2. Test file covers every SQL row of spec §3.7 plus the parity fixture's `logged` flags.
- **Acceptance criteria:**
  - VERIFY: `bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql tests/sql/plan-shares.test.sql` exits 0
  - VERIFY: the same run with the migration's token freeze removed fails (proves the test bites)
  - VERIFY: `node scripts/verify-supabase-schema.js --parse-only | grep -c "plan_shares\|get_shared_plans\|rotate_plan_share_token"` is at least 3 (the verifier picks them up from the migration file)

### Task S1-T4: Extend the live round-trip test
- **Complexity:** M
- **Depends on:** S1-T3
- **Parallel:** No
- **Files:** `scripts/test-ugc-roundtrip.mjs` (modify)
- **Description:** After the existing watchlist checks: user A upserts a share, a client-supplied token is ignored, anon RPC returns A's rows with no forbidden keys, user B can't read or update A's row, anon can't call rotate, rotate kills the old token, disable returns NULL; then delete the share. Skips with a clear message if the table doesn't exist yet so it can land before the apply.
- **Acceptance criteria:**
  - VERIFY: `node --test` style dry run is not possible locally (no Supabase access); instead `node scripts/test-ugc-roundtrip.mjs` with credentials unset exits with the script's existing "missing credentials" path, not a syntax/runtime error
  - VERIFY: after S1-T5's apply, a dispatched `test-ugc-roundtrip.yml` run is green and its log shows the plan_shares steps

### Task S1-T5: Land and apply the migration
- **Complexity:** S
- **Depends on:** S1-T3, S1-T4
- **Parallel:** No
- **Files:** none (operations)
- **Description:** Land via `land/bro-4481-db`, then in the same sitting dispatch `apply-migration.yml` (`confirm=APPLY`), then dispatch `test-ugc-roundtrip.yml` and `verify-schema.yml`.
- **Acceptance criteria:**
  - VERIFY: `apply-migration.yml` run concludes success
  - VERIFY: `verify-schema.yml` and `test-ugc-roundtrip.yml` runs conclude success after the apply

---

## Sprint 2: Viewer page
MODEL: Opus. Server/client split, caching behaviour and timezone logic.
**Demo:** a share row created by the S1 round-trip user (kept for the demo) renders at `/plans/<token>` on a preview deploy: both sections, a calendar add, an iMessage preview card. Stopping the share shows the "isn't being shared" page.
**Risks:** server-side show resolution may not have the data files traced into the serverless bundle (check `outputFileTracingExcludes` in `next.config.js`); Next's fetch cache; venue timezone for categories without a market mapping.

### Task S2-T1: Write selectSharedPlans
- **Complexity:** M
- **Depends on:** S1-T2
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/select.ts` (new), `src/lib/shared-plans/__tests__/select.test.ts` (new)
- **Description:** Pure function from RPC payload + resolved shows + now to booked/unbooked lists and counts, using `resolveTimeZone(category)` and the parity fixture.
- **Acceptance criteria:**
  - VERIFY: the repo's tsx unit-test runner passes `select.test.ts`, which loads every case in `shared-plans-parity.json`
  - VERIFY: test includes a 23:30 New York show "viewed" with `now` set in Asia/Tokyo and the show is still booked

### Task S2-T2: Add plan date formatting
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/format.ts` (new), `src/lib/shared-plans/__tests__/format.test.ts` (new)
- **Description:** `formatPlanDate('2026-10-18')` → "Sat, Oct 18", independent of process timezone.
- **Acceptance criteria:**
  - VERIFY: test passes under `TZ=America/Los_Angeles` and `TZ=Asia/Tokyo`

### Task S2-T3: Write server-side show resolution
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/resolve.ts` (new), `src/lib/shared-plans/__tests__/resolve.test.ts` (new)
- **Description:** ids → display rows via `getShowById`, then `getDiaryShowById` / `getShowStubById`, mirroring `/diary-show/[id]`. Unknown ids are dropped, not rendered as raw ids.
- **Acceptance criteria:**
  - VERIFY: test resolves three real ids from local data (one Broadway, one West End, one diary-only) and drops one fake id

### Task S2-T4: Write the share loader
- **Complexity:** S
- **Depends on:** S1-T3
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/load.ts` (new), `src/lib/shared-plans/__tests__/load.test.ts` (new)
- **Description:** `cache()`-wrapped RPC call with `fetch` forced to `no-store`; returns payload, `null` (not shared) or throws (unavailable).
- **Acceptance criteria:**
  - VERIFY: test with an injected client covers payload / null / error, and asserts the fetch passed to the client sets `cache: 'no-store'`

### Task S2-T5: Let buildPlannedShowEvent produce all-day events with companions
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/calendar-event.ts` (modify), its existing test file (modify)
- **Description:** `{ allDay, companions }` options per spec §3.4; existing callers unchanged.
- **Acceptance criteria:**
  - VERIFY: existing calendar-event tests still pass; new cases: no curtain time + `allDay` → `time: null`; companions passed through; SUMMARY has exactly one 🎭 in `buildIcs` output

### Task S2-T6: Serve all-day .ics without the env gate
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/app/api/calendar.ics/route.ts` (modify), route test (new or extend)
- **Description:** No `t` param → served regardless of `CALENDAR_EXPORT_ENABLED`; timed events keep the gate.
- **Acceptance criteria:**
  - VERIFY: route test with env unset: all-day → 200 `text/calendar` with `DTSTART;VALUE=DATE`; timed → 404

### Task S2-T7: Move the calendarExport check to AddToCalendarButtons' callers
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/components/user/AddToCalendarButtons.tsx`, `src/components/show-page/ShowHeroRedesign.tsx`, `src/components/user/ShowPageWatchlistButton.tsx`, `src/app/my-shows/MyShowsClient.tsx`
- **Description:** Pure refactor; no visible change anywhere.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` clean; `grep -n calendarExport` shows the check in the three callers and not in the component
  - VERIFY: existing my-shows mock Playwright spec passes

### Task S2-T8: Build the plans page shell and its states
- **Complexity:** M
- **Depends on:** S2-T1, S2-T3, S2-T4
- **Parallel:** No
- **Files:** `src/app/plans/[token]/page.tsx` (new), `src/app/plans/[token]/not-found.tsx` (new), `src/app/plans/[token]/SharedPlansView.tsx` (new), `src/app/test/plans-fixture/page.tsx` (new, mock payload through the same view)
- **Description:** Server page (force-dynamic, noindex, no-referrer, metadata from counts), 404 and 503 states, display-only view built from show-cards components with calendar buttons.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` and `npx next lint` clean
  - VERIFY: Playwright spec against the fixture route covers populated, empty, not-shared and unavailable states
  - VERIFY: `/visual-qa` verdict at 375 px and 1280 px

### Task S2-T9: Add the preview image
- **Complexity:** M
- **Depends on:** S2-T8
- **Parallel:** No
- **Files:** `src/app/plans/[token]/opengraph-image.tsx` (new)
- **Description:** Same loader + selection; name, counts, up to 4 posters; generic card for unknown tokens; force-dynamic.
- **Acceptance criteria:**
  - VERIFY: on the preview/prod deploy, `curl -sI https://broadwayscorecard.com/plans/<demo-token>/opengraph-image` returns `200 image/*`; an unknown token returns the generic card
  - VERIFY: `curl -sI https://broadwayscorecard.com/plans/<demo-token>` shows `Cache-Control` containing `no-store` and an `X-Robots-Tag`/meta noindex

---

## Sprint 3: Analytics redaction
MODEL: Opus. Touches a shared, sitewide component.
**Demo:** visiting `/plans/<token>` produces PostHog, Vercel, GA and Sentry payloads that contain `/plans/:token` and never the real token.
**Risks:** PostHog `before_send` property names differ by version (installed `posthog-js ^1.422`); GA config runs in an inline script string.

### Task S3-T1: Write redactSharedPlanUrl
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/analytics/redact-url.ts` (new), test (new)
- **Acceptance criteria:**
  - VERIFY: test covers absolute URL, path, query/hash, referrer from another site, and a non-plans URL left unchanged

### Task S3-T2: Wire redaction into every analytics tool
- **Complexity:** M
- **Depends on:** S3-T1
- **Parallel:** No
- **Files:** `src/components/AnalyticsWrapper.tsx` (modify), `src/lib/analytics/__tests__/redaction-wiring.test.ts` (new)
- **Description:** PostHog `before_send`, Vercel `<Analytics beforeSend>`, GA `page_location`/`page_referrer`, Sentry `beforeSend`; stop session recording on `/plans/*`. The test pushes a sample event through each exported hook, and a grep assertion fails if a new analytics init bypasses the redactor.
- **Acceptance criteria:**
  - VERIFY: wiring test passes and fails when any one hook is removed
  - VERIFY: on the deployed site, PostHog's live events for a `/plans/` visit show `/plans/:token` (checked by Claude via PostHog API if the key is available, else by browser network capture with Playwright)

### Task S3-T3: Fire viewer events
- **Complexity:** M
- **Depends on:** S2-T8, S3-T2
- **Parallel:** No
- **Files:** `src/app/plans/[token]/SharedPlansView.tsx`, `src/lib/posthog-events.ts` (modify)
- **Acceptance criteria:**
  - VERIFY: Playwright fixture spec asserts `plans_page_viewed` on mount, `plans_show_tapped` on a row tap, `plans_calendar_added` on a calendar click (via the existing event-capture test helper)

---

## Sprint 4: Web owner UI and the real trial
MODEL: Sonnet for S4-T1/T2, Opus for the rest.
**Demo:** the owner shares from demo.broadwayscorecard.com, the partner opens the link on their phone.
**Risks:** demo site and prod share one Supabase project (assumed; confirm in S4-T6); `navigator.share` behaviour in desktop Safari.

### Task S4-T1: Write shareOrCopy
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/share-link.ts` (new), test (new)
- **Acceptance criteria:**
  - VERIFY: tests for shared / AbortError → cancelled / no navigator.share → copied / share throws → copied

### Task S4-T2: Migrate ListsTab and Beat the Critics to shareOrCopy
- **Complexity:** S
- **Depends on:** S4-T1
- **Parallel:** No
- **Files:** `src/app/my-shows/ListsTab.tsx`, `src/app/beat-the-critics/BeatTheCriticsClient.tsx`
- **Acceptance criteria:**
  - VERIFY: `grep -n "navigator.share\|clipboard.writeText" src/app/my-shows/ListsTab.tsx src/app/beat-the-critics/BeatTheCriticsClient.tsx` returns nothing; tsc + lint clean

### Task S4-T3: Write usePlanShare
- **Complexity:** M
- **Depends on:** S1-T5
- **Parallel:** Yes
- **Files:** `src/hooks/usePlanShare.ts` (new)
- **Description:** `share`, `ensure`, `update`, `rotate`; URLs from `BASE_URL`; name brand guard.
- **Acceptance criteria:**
  - VERIFY: tsc clean; unit test of the URL builder and brand guard

### Task S4-T4: Build SharePlansModal
- **Complexity:** M
- **Depends on:** S4-T1, S4-T3, S2-T1
- **Parallel:** No
- **Files:** `src/components/user/SharePlansModal.tsx` (new), `src/app/my-shows/__dev-mock-data.ts` (modify)
- **Acceptance criteria:**
  - VERIFY: my-shows mock Playwright spec opens the modal, sees counts matching `selectSharedPlans` on the mock data, Share disabled with both toggles off or empty name
  - VERIFY: `/visual-qa` verdict at 375 / 1280 px

### Task S4-T5: Mount the Share button and owner events
- **Complexity:** S
- **Depends on:** S4-T4
- **Parallel:** No
- **Files:** `src/app/my-shows/MyShowsClient.tsx`
- **Acceptance criteria:**
  - VERIFY: mock spec: button visible with ≥1 watchlist show, hidden with none

### Task S4-T6: Land, then run the owner trial and prod smoke
- **Complexity:** M
- **Depends on:** S2-T9, S3-T3, S4-T5
- **Parallel:** No
- **Files:** none (operations)
- **Description:** Manual-before-automated step. Land Sprints 2–4, confirm prod deploy, then the owner creates a share on the demo site and texts it to their partner; Claude runs the spec §3.7 prod smoke list.
- **Acceptance criteria:**
  - VERIFY: `node scripts/check-prod-deploy.js HEAD` exits 0
  - VERIFY: every prod-smoke line in spec §3.7 recorded as checked in the Linear issue, with the preview-card screenshots

---

## Sprint 5: iOS
MODEL: Opus.
**Demo:** in a TestFlight build with `planSharing` on, the To Watch tab's share button opens the sheet and Messages shows the preview card.
**Risks:** push access to the app repo; WhatsApp dropping text or link; OTA reaching users before the flag check exists (the flag check must ship in the same update as the button).

### Task S5-T1: Attach the app repo with push access and port selectSharedPlans
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** Yes
- **Files (app repo):** `lib/shared-plans-select.ts` (new), `tests/unit/shared-plans-select.test.mjs` (new), `tests/fixtures/shared-plans-parity.json` (copy)
- **Acceptance criteria:**
  - VERIFY: `npm run test:unit` passes, including every parity fixture case

### Task S5-T2: Write the app's usePlanShare
- **Complexity:** S
- **Depends on:** S1-T5
- **Parallel:** Yes
- **Files (app repo):** `hooks/usePlanShare.ts` (new)
- **Acceptance criteria:**
  - VERIFY: `npm run typecheck` clean

### Task S5-T3: Build SharePlansSheet
- **Complexity:** M
- **Depends on:** S5-T1, S5-T2
- **Parallel:** No
- **Files (app repo):** `components/user/SharePlansSheet.tsx` (new)
- **Acceptance criteria:**
  - VERIFY: typecheck + `npm run lint` + `npm run lint:design` clean

### Task S5-T4: Add the header button behind planSharing
- **Complexity:** S
- **Depends on:** S5-T3
- **Parallel:** No
- **Files (app repo):** `app/(tabs)/to-watch.tsx`, `lib/analytics.ts`
- **Acceptance criteria:**
  - VERIFY: with `planSharing` absent from `app.json` features the button does not render (unit/maestro check or a render test if the repo has one); typecheck clean

### Task S5-T5: Push and build for TestFlight
- **Complexity:** S
- **Depends on:** S5-T4, S4-T6
- **Parallel:** No
- **Files:** none (operations)
- **Acceptance criteria:**
  - VERIFY: the app's build workflow run with `force_build=true` concludes success

### Task S5-T6: Switch planSharing on
- **Complexity:** M
- **Depends on:** S5-T5 and the owner having tried it
- **Parallel:** No
- **Files (app repo):** `app.json`
- **Description:** One-line flag flip, shipped OTA. Then share from the app to Messages, WhatsApp, Mail and Copy and check each result.
- **Acceptance criteria:**
  - VERIFY: OTA publish run concludes success; per-app share results recorded in Linear

---

## Sprint 6: Close-out
MODEL: Sonnet.

### Task S6-T1: File V2 cards
- **Complexity:** S
- **Depends on:** S5-T6
- **Files:** none
- **Acceptance criteria:**
  - VERIFY: Linear issues exist for per-show hiding, sign-up nudge, view counts, in-app `/plans` screen, "Join" on booked rows

### Task S6-T2: Close BRO-4481
- **Complexity:** S
- **Depends on:** S6-T1
- **Acceptance criteria:**
  - VERIFY: `linear-brain.js update BRO-4481 --state Done` succeeds with a `PR-EVIDENCE:` line citing the landed commit

---

## Dependencies Graph
```
S1-T1 → S1-T3 → S1-T4 → S1-T5 ─┬→ S4-T3 → S4-T4 → S4-T5 ─┐
S1-T2 → S2-T1 ─────────────────┼→ S2-T8 → S2-T9 ─────────┼→ S4-T6 → S5-T5 → S5-T6 → S6
S2-T2, S2-T3, S2-T4 ───────────┘     ↑                    │
S2-T5, S2-T6, S2-T7 (independent) ───┘                    │
S3-T1 → S3-T2 → S3-T3 ────────────────────────────────────┘
S4-T1 → S4-T2
S2-T1 → S5-T1 ─┐
S1-T5 → S5-T2 ─┴→ S5-T3 → S5-T4 → S5-T5
```

## Subagent Execution Map (within one /execute-plan session)
Do not split tracks across separate Claude Code sessions.

```
Subagent track 1:  S1-T1 → S1-T3 → S1-T4 → S1-T5
Subagent track 2:  S1-T2 → S2-T1 → S2-T2
Subagent track 3:  S2-T5 → S2-T6 → S2-T7
Sync:              ─────────── after S1 + S2-T1..T7 ───────────
Subagent track 1:  S2-T3 → S2-T4 → S2-T8 → S2-T9
Subagent track 2:  S3-T1 → S3-T2 → (sync) S3-T3
Subagent track 3:  S4-T1 → S4-T2 → S4-T3 → S4-T4 → S4-T5
Sync:              ─────────── S4-T6 trial ───────────
Subagent track 1:  S5-T1 … S5-T6 (app repo, sequential)
```

**Parallel sprints:** Sprint 3 shares no files with Sprint 2 except `SharedPlansView.tsx` (S3-T3 runs after S2-T8). Sprint 4's T1–T3 share no files with Sprint 2.
**Critical path:** S1-T1 → S1-T3 → S1-T4 → S1-T5 → S4-T3 → S4-T4 → S4-T5 → S4-T6 → S5-T5 → S5-T6.
**Max subagent parallelism:** 3.
**Cross-session plan:** Session 1: Sprint 1 + Sprint 2 pure tasks (T1–T7). Session 2: S2-T8/T9 + Sprint 3. Session 3: Sprint 4 including the trial. Session 4: Sprint 5 + close-out. Each session lands before the next starts.

## Known Edge Cases
- West End shows across the late-October UK clock change (fixture case).
- A show re-booked after it was reviewed: future date → Booked even though a review exists.
- An undated review (diary import) marks every past planned date for that show as logged.
- A diary-only show that is also missing from `diary-lookup` (added via live stub today): resolved through `getShowStubById`.
- A watchlist with 300+ rows: RPC cap; the page shows what it gets.
- Owner signed in with Apple and no profile name: name field starts empty and blocks sharing.
- Demo site minting links: always `BASE_URL`.

## Changes from Critique
| Change | Reason | Source |
|--------|--------|--------|
| Live round-trip extends `scripts/test-ugc-roundtrip.mjs` instead of editing the workflow | A workflow edit is shared infrastructure (CLAUDE.md §18) and isn't needed | Plan-tasks review (self), CI file read |
| S2-T7 (flag move) made its own task with a regression check | Touches three unrelated callers | Plan-tasks review |
| S4-T6 trial placed before any iOS push | Manual before automated; demo site has no public users | Plan review (structure, user impact) |
| Preview card and page caching verified on the live deploy, not via config | Next 14 behaviour differs from config intent | Plan review (structure, pre-mortem) |

## Key Risks
1. **Token leakage through analytics.** Mitigation: Sprint 3 lands in the same release as the page; wiring test fails if a hook is dropped.
2. **Server-side data files missing from the serverless bundle** (show resolution on a force-dynamic route). Mitigation: `/diary-show/[id]` already does this on demand; S2-T9's live check exercises it.
3. **Friend's page disagreeing with the owner's app.** Mitigation: one parity fixture tested in SQL, web and iOS.
