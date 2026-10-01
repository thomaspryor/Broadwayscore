# Sprint Plan: Share My Theater Plans (BRO-4481)

## Overview
A live, login-free link (`/plans/<token>`) that shows a user's booked shows (date only) and their not-yet-booked watchlist, shared from a share sheet on web and iOS. Spec and reviewed technical plan: `docs/specs/shared-plans.md`. Per-show hiding is V2 (owner, 2026-10-01).

Environment facts checked while planning: the cloud sandbox has PostgreSQL 16 and Docker, so SQL is tested locally first; the live-database check extends the existing `scripts/test-ugc-roundtrip.mjs` (no workflow edit needed); the iOS repo is public and readable, and pushing to it needs `add_repo` with push access.

Test conventions (apply to every web task below): new unit tests run through `npm run test:unit` (`scripts/run-unit-tests.js`) and **only if listed** in `tests/unit-test-manifest-tsx.txt` (TypeScript) or `tests/unit-test-manifest.txt` (JS). Each task that adds a test also adds its manifest line. There are no preview deploys (git builds are blocked; `vercel-deploy.yml` deploys prod only), so pre-land demos run on a local `next build && next start` with `NEXT_PUBLIC_FEATURES=userAccounts,showPageRedesign,showtimes`.

**Landing rule:** Sprints 2, 3 and 4 land **together**, after S3-T2. Landing the page before the analytics redaction would put live tokens into analytics tools.

Roadmap check: the roadmap lives in `thomaspryor/broadway-scorecard-data` issue 1, which is outside this session's repository scope; no overlap found in Linear (`linear-brain.js find` for "share watchlist" / "shared plans" returned nothing). Related, not blocking: `docs/specs/diary-sharing-and-calendar.md`.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 1 | Database live: share table, guard trigger, public read function, tested locally and on prod | 5 | 2S, 3M |
| 2 | A share created by the round-trip fixture user renders at `/plans/<token>` on a local production build | 9 | 4S, 5M |
| 3 | The token never reaches analytics tools | 4 | 1S, 3M |
| 4 | Owner can create and share their link from the web (demo site); Sprints 2–4 land; real trial with the partner | 6 | 3S, 3M |
| 5 | Owner can share from the iOS app; released behind a flag, then switched on | 7 | 4S, 3M |
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
- **Files:** `tests/fixtures/shared-plans-parity.json` (new), `tests/unit/shared-plans-parity-fixture.test.js` (new), `tests/unit-test-manifest.txt`
- **Description:** One JSON file of watchlist rows + review dates + a "today" per market, with the expected booked / want-to-see / excluded result for each row (future, today, past-unlogged, past-logged, re-booked after a review, undated review, closed show, West End across the UK clock change). Web, SQL and iOS tests all read it.
- **Acceptance criteria:**
  - VERIFY: `node -e "JSON.parse(require('fs').readFileSync('tests/fixtures/shared-plans-parity.json'))"` exits 0
  - VERIFY: `tests/unit/shared-plans-parity-fixture.test.js` (new, in `tests/unit-test-manifest.txt`) asserts every case has `input`/`expected` and every bucket appears at least once; `npm run test:unit` passes

### Task S1-T3: Write the plan_shares migration
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** `supabase/migrations/20261001_plan_shares.sql` (new), `tests/sql/plan-shares.test.sql` (new)
- **Description:** Table, owner-only RLS, `plan_shares_guard` trigger (token minted on insert, frozen on update unless rotating, trims name, bumps updated_at), `rotate_plan_share_token()`, `get_shared_plans(p_token)`, and the REVOKE/GRANT block, exactly per spec §3.1–3.2. Test file covers every SQL row of spec §3.7 plus the parity fixture's `logged` flags.
- **Acceptance criteria:**
  - VERIFY: `bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql tests/sql/plan-shares.test.sql` exits 0
  - VERIFY: `sed '/NEW.token := OLD.token/d' supabase/migrations/20261001_plan_shares.sql > $SCRATCH/mut.sql && bash scripts/test-plan-shares-sql.sh $SCRATCH/mut.sql tests/sql/plan-shares.test.sql` exits non-zero (proves the test bites)
  - VERIFY: `node scripts/verify-supabase-schema.js --parse-only | grep -c "plan_shares\|get_shared_plans\|rotate_plan_share_token"` is at least 3 (the verifier picks them up from the migration file)

### Task S1-T4: Extend the live round-trip test
- **Complexity:** M
- **Depends on:** S1-T3
- **Parallel:** No
- **Files:** `scripts/test-ugc-roundtrip.mjs` (modify), `tests/unit/ugc-roundtrip-plan-shares.test.js` (new), `tests/unit-test-manifest.txt`
- **Description:** After the existing watchlist checks: user A upserts a share, a client-supplied token is ignored, anon RPC returns A's rows with no forbidden keys, user B can't read or update A's row, anon can't call rotate, rotate kills the old token, disable returns NULL; then delete the share. Skips with a clear message if the table doesn't exist yet so it can land before the apply.
- **Acceptance criteria:**
  - VERIFY: the plan_shares steps live in an exported function; `tests/unit/ugc-roundtrip-plan-shares.test.js` drives it against a stub `fetch` (expected requests, forbidden-key detection, skip-when-table-missing). Running the script with credentials unset only proves it parses, so it isn't counted
  - VERIFY: after S1-T5's apply, a dispatched `test-ugc-roundtrip.yml` run is green and its log shows the plan_shares steps

### Task S1-T5: Land and apply the migration
- **Complexity:** S
- **Depends on:** S1-T3, S1-T4
- **Parallel:** No
- **Files:** none (operations)
- **Description:** Land via `land/bro-4481-db` and **wait for the land run to fast-forward main** (`apply-migration.yml` reads the file from main). Then, in the same sitting, dispatch `apply-migration.yml` (`confirm=APPLY`), then `test-ugc-roundtrip.yml` and `verify-schema.yml`.
- **Acceptance criteria:**
  - VERIFY: `apply-migration.yml` run concludes success
  - VERIFY: `verify-schema.yml` and `test-ugc-roundtrip.yml` runs conclude success after the apply

---

## Sprint 2: Viewer page
MODEL: Opus. Server/client split, caching behaviour and timezone logic.
**Demo:** on a local `next build && next start` pointed at the live Supabase project, a share created for the round-trip fixture user renders at `/plans/<token>`: both sections, a calendar add, the preview image route. Disabling it shows the "isn't being shared" page. Nothing lands until S3-T2 is done.
**Risks:** server-side show resolution may not have the data files traced into the serverless bundle (check `outputFileTracingExcludes` in `next.config.js`); Next's fetch cache; venue timezone for categories without a market mapping.

### Task S2-T1: Write selectSharedPlans
- **Complexity:** M
- **Depends on:** S1-T2
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/select.ts` (new), `src/lib/shared-plans/__tests__/select.test.ts` (new), `tests/unit-test-manifest-tsx.txt`
- **Description:** Pure function from RPC payload + resolved shows + now to booked/unbooked lists and counts, using `resolveTimeZone(category)` and the parity fixture.
- **Acceptance criteria:**
  - VERIFY: the repo's tsx unit-test runner passes `select.test.ts`, which loads every case in `shared-plans-parity.json`
  - VERIFY: test includes a 23:30 New York show "viewed" with `now` set in Asia/Tokyo and the show is still booked
  - VERIFY: a show whose category `resolveTimeZone` doesn't map falls back to America/New_York (asserted)

### Task S2-T2: Add plan date formatting
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/format.ts` (new), `src/lib/shared-plans/__tests__/format.test.ts` (new), `tests/unit-test-manifest-tsx.txt`
- **Description:** `formatPlanDate('2026-10-18')` → "Sat, Oct 18", independent of process timezone.
- **Acceptance criteria:**
  - VERIFY: test passes under `TZ=America/Los_Angeles` and `TZ=Asia/Tokyo`

### Task S2-T3: Write server-side show resolution
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/resolve.ts` (new), `src/lib/shared-plans/__tests__/resolve.test.ts` (new), `tests/unit-test-manifest-tsx.txt`
- **Description:** ids → display rows via `getShowById`, then `getDiaryShowById` / `getShowStubById`, mirroring `/diary-show/[id]`. Unknown ids are dropped, not rendered as raw ids.
- **Acceptance criteria:**
  - VERIFY: resolver takes its three lookups as injectable dependencies; the test injects small fixtures (Broadway, West End, a `diary-lookup` id, a `-mz…` stub id) and drops one fake id, so it doesn't need private core data or Supabase in CI. A second, local-only smoke run against real data resolves three real ids

### Task S2-T4: Write the share loader
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/shared-plans/load.ts` (new), `src/lib/shared-plans/__tests__/load.test.ts` (new), `src/lib/supabase-server.ts` (add an optional `fetch` option), `tests/unit-test-manifest-tsx.txt`
- **Description:** `cache()`-wrapped RPC call with `fetch` forced to `no-store`; returns payload, `null` (not shared) or throws (unavailable).
- **Acceptance criteria:**
  - VERIFY: test with an injected client covers payload / null / error / **no client (env missing) → unavailable (503), never not-shared (404)**, and asserts the fetch passed to the client sets `cache: 'no-store'`

### Task S2-T5: Let buildPlannedShowEvent produce all-day events with companions
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/calendar-event.ts` (modify), `tests/unit/showtime-picker.test.ts` (modify; it already covers `buildPlannedShowEvent`)
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
  - VERIFY: `/visual-qa` verdict on a show page and My Shows (it edits UI files, CLAUDE.md §5)

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
  - VERIFY: auth-aware `npm run build` succeeds (catches force-dynamic and file-tracing failures, CLAUDE.md §12)
  - VERIFY: on local `next start`, `curl -sI localhost:3000/plans/<fixture-token>` shows `Cache-Control` containing `no-store`, and the HTML carries `noindex` and `no-referrer` meta tags

### Task S2-T9: Add the preview image
- **Complexity:** M
- **Depends on:** S2-T8
- **Parallel:** No
- **Files:** `src/app/plans/[token]/opengraph-image.tsx` (new)
- **Description:** Same loader + selection; name, counts, up to 4 posters; generic card for unknown tokens; force-dynamic.
- **Acceptance criteria:**
  - VERIFY: on local `next start`, `curl -sI localhost:3000/plans/<fixture-token>/opengraph-image` returns `200 image/*`; an unknown token returns the generic card
  - VERIFY: auth-aware `npm run build` succeeds
  - (The same two checks repeat on prod in S4-T6.)

---

## Sprint 3: Analytics redaction
MODEL: Opus. Touches a shared, sitewide component.
**Demo:** visiting `/plans/<token>` produces PostHog, Vercel, GA and Sentry payloads that contain `/plans/:token` and never the real token.
**Risks:** PostHog `before_send` property names differ by version (installed `posthog-js ^1.422`); GA config runs in an inline script string. `AnalyticsWrapper.tsx` is sitewide: run `/second-opinion` before S3-T2 even though §18's scope list doesn't name it.

### Task S3-T1: Write redactSharedPlanUrl
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/analytics/redact-url.ts` (new), test (new), `tests/unit-test-manifest-tsx.txt`
- **Acceptance criteria:**
  - VERIFY: test covers absolute URL, path, query/hash, referrer from another site, and a non-plans URL left unchanged

### Task S3-T2: Wire redaction into every analytics tool
- **Complexity:** M
- **Depends on:** S3-T1
- **Parallel:** No
- **Files:** `src/components/AnalyticsWrapper.tsx` (modify), `src/lib/analytics/__tests__/redaction-wiring.test.ts` (new), `tests/unit-test-manifest-tsx.txt`
- **Description:** PostHog `before_send`, Vercel `<Analytics beforeSend>` and `<SpeedInsights beforeSend>`, GA `page_location`/`page_referrer`, Sentry `beforeSend`; stop session recording on `/plans/*`. The test pushes a sample event through each exported hook, and a grep assertion fails if a new analytics init bypasses the redactor.
- **Acceptance criteria:**
  - VERIFY: wiring test passes and fails when any one hook is removed
  - VERIFY: Playwright network capture on local `next start` (analytics keys set) shows no request body or URL to PostHog, Vercel, GA or Sentry containing the fixture token; repeated on prod in S4-T6

### Task S3-T2b: Build an analytics event-capture test helper
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `tests/e2e/helpers/capture-events.ts` (new)
- **Description:** No such helper exists yet. Stubs `window.posthog.capture` and Vercel `track` via `page.addInitScript`, records calls, and exposes `expectEvent(name, props?)`.
- **Acceptance criteria:**
  - VERIFY: a tiny self-test spec using it passes against an existing page that already fires a known event

### Task S3-T3: Fire viewer events
- **Complexity:** M
- **Depends on:** S2-T8, S3-T2, S3-T2b
- **Parallel:** No
- **Files:** `src/app/plans/[token]/SharedPlansView.tsx`, `src/lib/posthog-events.ts` (modify)
- **Acceptance criteria:**
  - VERIFY: Playwright fixture spec asserts `plans_page_viewed` on mount, `plans_show_tapped` on a row tap, `plans_calendar_added` on a calendar click (via `capture-events.ts`)

---

## Sprint 4: Web owner UI and the real trial
MODEL: Sonnet for S4-T1/T2, Opus for the rest.
**Demo:** the owner shares from demo.broadwayscorecard.com, the partner opens the link on their phone.
**Risks:** demo site and prod share one Supabase project (assumed; confirm in S4-T6); `navigator.share` behaviour in desktop Safari.

### Task S4-T1: Write shareOrCopy
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/share-link.ts` (new), test (new), `tests/unit-test-manifest-tsx.txt`
- **Acceptance criteria:**
  - VERIFY: tests for shared / AbortError → cancelled / no navigator.share → copied / share throws → copied

### Task S4-T2: Move the Lists share button to shareOrCopy and BASE_URL
- **Complexity:** S
- **Depends on:** S4-T1
- **Parallel:** No
- **Files:** `src/app/my-shows/ListsTab.tsx`, `src/hooks/useUserLists.ts`
- **Description:** Same class of bug as the plans link: list links are built from `window.location.origin`, so lists shared from the demo site point at demo. Beat the Critics stays as is (different share payload, out of scope).
- **Acceptance criteria:**
  - VERIFY: `grep -n "window.location.origin" src/hooks/useUserLists.ts src/app/my-shows/ListsTab.tsx` returns nothing; tsc + lint clean; my-shows mock spec passes

### Task S4-T3: Write usePlanShare
- **Complexity:** M
- **Depends on:** S1-T5
- **Parallel:** Yes
- **Files:** `src/hooks/usePlanShare.ts` (new), `src/lib/shared-plans/share-url.ts` (new, pure URL builder + brand guard), test (new), `tests/unit-test-manifest-tsx.txt`
- **Description:** `share`, `ensure`, `update`, `rotate`; URLs from `BASE_URL`; name brand guard.
- **Acceptance criteria:**
  - VERIFY: tsc clean; unit test of the URL builder and brand guard passes

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
  - VERIFY: auth-aware `npm run build` succeeds; `/visual-qa` verdict on the Watchlist tab

### Task S4-T6: Land, then run the owner trial and prod smoke
- **Complexity:** M
- **Depends on:** S2-T9, S3-T3, S4-T5
- **Parallel:** No
- **Files:** none (operations)
- **Description:** Manual-before-automated step. Land Sprints 2–4 together (never Sprint 2 alone), confirm prod deploy, repeat S2-T8/T9's header, preview-image and analytics network checks on prod, then the owner creates a share on the demo site and texts it to their partner; Claude runs the spec §3.7 prod smoke list.
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

### Task S5-T2b: Add the plan_shares security test the app's CI requires
- **Complexity:** S
- **Depends on:** S5-T2
- **Parallel:** No
- **Files (app repo):** `tests/security/plan-shares-adversarial.test.mjs` (new)
- **Description:** `tests/unit/every-user-table-has-a-security-test.test.mjs` fails once app code touches a new user table. Mirror the existing adversarial tests: other users can't read/update the row, client token writes are ignored, anon can't rotate.
- **Acceptance criteria:**
  - VERIFY: `npm test` passes, including `every-user-table-has-a-security-test`

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
  - VERIFY: a pure `isPlanSharingEnabled()` in `lib/feature-flags.ts` is unit-tested in `tests/unit/` (absent → false, present → true); the button renders only when it returns true; typecheck clean

### Task S5-T5: Push and build for TestFlight
- **Complexity:** S
- **Depends on:** S5-T2b, S5-T4, S4-T6
- **Parallel:** No
- **Files:** none (operations)
- **Acceptance criteria:**
  - VERIFY: the app's build workflow run with `force_build=true` concludes success

### Task S5-T6: Switch planSharing on
- **Complexity:** M
- **Depends on:** S5-T5 and the owner having tried it
- **Parallel:** No
- **Files (app repo):** `app.json`
- **Description:** One-line flag flip, shipped OTA through `scripts/ship.js` / `eas-build.yml`. Before relying on it, confirm an OTA update's `extra.features` actually reaches `Constants.expoConfig` (check how existing flags were launched in the app's git log; if it needs a native build, use `force_build=true`). Then share from the app to Messages, WhatsApp, Mail and Copy and check each result.
- **Acceptance criteria:**
  - VERIFY: `eas-build.yml` run concludes success; per-app share results recorded in Linear

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
S1-T1 → S1-T3 → S1-T4 → S1-T5 ─┬→ S4-T3 → S4-T4 → S4-T5 ──┐
                               └→ S5-T2 → S5-T2b ─┐        │
S1-T2 → S2-T1 → S5-T1 ──────────────────────────┴→ S5-T3 → S5-T4 ─┐
S2-T1, S2-T3, S2-T4 → S2-T8 → S2-T9 ─┐                             │
S2-T2, S2-T5, S2-T6, S2-T7 ──────────┤                             │
S3-T1 → S3-T2, S3-T2b → S3-T3 ───────┴→ (land S2+S3+S4) S4-T6 ─────┴→ S5-T5 → S5-T6 → S6
S4-T1 → S4-T2
```

## Subagent Execution Map (within one /execute-plan session)
Do not split tracks across separate Claude Code sessions. Shared files (`SharedPlansView.tsx`, `MyShowsClient.tsx`, manifests) each stay on one track at a time; manifest edits are appended by the coordinator at commit time to avoid conflicts.

```
Subagent track A (DB → iOS data):   S1-T1 → S1-T3 → S1-T4 → S1-T5 → S5-T2 → S5-T2b
Subagent track B (pure libraries):  S1-T2 → S2-T1 → S2-T2 → S2-T3 → S2-T4 → S5-T1
Subagent track C (calendar, analytics, sharing): S2-T5 → S2-T6 → S2-T7 → S3-T1 → S3-T2 → S3-T2b → S4-T1 → S4-T2
Sync 1 ──────────────────────────────────────────────
Track A: S2-T8 → S2-T9 → S3-T3         Track C: S4-T3 → S4-T4 → S4-T5
Sync 2 ── land S2+S3+S4 together → S4-T6 trial ──
Track A: S5-T3 → S5-T4 → S5-T5 → S5-T6 → S6
```

**Critical path:** S1-T1 → S1-T3 → S1-T4 → S1-T5 → S4-T3 → S4-T4 → S4-T5 → land → S4-T6 → S5-T5 → S5-T6.
**Max subagent parallelism:** 3.
**Cross-session plan:** Session 1: tracks A/B/C up to Sync 1 (database applied, pure libraries, calendar, analytics). Session 2: Sync 1 work + land S2–S4 + trial. Session 3: iOS + close-out. Each session pushes before the next starts.

## Self-validation (plan-tasks Phase 3)
1. Completeness: PASS. Sprint 1 demos SQL locally and on prod; Sprint 2 on a local production build; the first public moment is S4-T6.
2. Atomicity: PASS after splitting the capture helper (S3-T2b) and the app security test (S5-T2b) out.
3. Dependency chain: PASS, no cycles; S2-T4's false dependency on S1-T3 removed.
4. Test coverage: PASS. Every task has a yes/no check; the two "if it exists" checks were replaced.
5. Missing work: PASS after adding manifests, the auth-aware build, SpeedInsights, the app security test, the land-then-apply order.
6. Ordering: PASS. Analytics redaction lands with the page.
7. Parallel workstreams: PASS, three tracks.
8. Manual before automated: PASS. Owner trial (S4-T6) before the app release; flag flip after the owner tries it.
9. Scale: PASS. RPC capped at 300 rows; page work is per request and bounded by that cap.

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
| Sprints 2–4 land together, after analytics redaction | Landing the page first would leak tokens into analytics | Task review |
| Local production build replaces "preview deploy" | There are no preview deploys in this project | Task review |
| Manifest registration on every new test | Tests not in the manifest never run in CI | Task review |
| Added S3-T2b capture helper, S5-T2b app security test, SpeedInsights redaction, auth-aware build checks | Missing helper, app CI gate, missed URL sender, §12 | Task review |
| S4-T2 narrowed to ListsTab + `BASE_URL`; Beat the Critics left alone | Scope creep; the real bug is demo-origin list links | Task review |

## Key Risks
1. **Token leakage through analytics.** Mitigation: Sprint 3 lands in the same release as the page; wiring test fails if a hook is dropped.
2. **Server-side data files missing from the serverless bundle** (show resolution on a force-dynamic route). Mitigation: `/diary-show/[id]` already does this on demand; S2-T9's live check exercises it.
3. **Friend's page disagreeing with the owner's app.** Mitigation: one parity fixture tested in SQL, web and iOS.
