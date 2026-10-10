# Spec: Share My Theater Plans

**Status:** Revised after `/plan-review` (6 reviewers, 2026-10-01). Pre-build. Changes from the first draft are marked `[CHANGED: reason — source]`.
**Linear:** BRO-4481
**Author:** Claude (session 2026-10-01), from owner request
**Scope:** Web (Next.js on Vercel) and iOS (`BroadwayScorecard-app`, Expo)

---

## 1. Brief

**The ask (owner, 2026-10-01):** "I want to be able to share out my list of upcoming shows with friends, so they can see what shows they might want to join with me, or just see what shows I haven't booked yet on my watchlist. From the web version and the iOS version. So it needs a share sheet." Follow-up: "Others should not need to log in to see my list. BUT they should have some light encouragement to make their own account. V2 for that."

**What we build:** one link per person that shows their theater plans. Two sections:

- **Booked**: shows with an upcoming date, soonest first. Date only, no curtain time.
- **Want to see**: shows on the watchlist that aren't booked.

The owner taps **Share** on the watchlist (web: My Shows → Watchlist; iOS: To Watch tab). The share sheet opens with the link (iMessage, WhatsApp, Mail, copy). A friend opens it in any browser, no account needed, and sees the list with posters and scores. They can tap a show to read about it, or add one of the owner's booked dates to their own calendar.

**Why it matters:** today the only way to tell a friend "here's what I'm seeing, come along" is screenshots. A live link stays current without resending, and every opened link is a visitor landing on a page full of scored shows. That becomes a growth loop in V2, when the page starts inviting viewers to make their own list.

**Owner decisions (2026-10-01, via question round):**

| Question | Answer |
|---|---|
| What's on the page | Both sections, and the owner can switch either one off |
| Date detail for booked shows | Date only (no time) |
| Link behaviour | Live: one link, always current; can be turned off or reset |
| What viewers can do (V1) | Tap through to show pages; add a booked date to their calendar |
| Sign-up nudge for viewers | V2 |
| Hide individual shows from the share | V2 (owner, 2026-10-01) |

**Out of V1:** hiding individual shows, "I'm interested" taps, per-show notes, opening the link inside the iOS app, sign-up nudge, view counts for the owner, link expiry, follower/friend graph.

### Relation to the existing diary-sharing spec

`docs/specs/diary-sharing-and-calendar.md` covers a *different* object: an invite to **one** dated performance ("join me at Wicked on Oct 18"), with join-into-your-diary semantics that need the viewer to sign in. This spec is the **whole list**, read-only, anonymous. They compose: once that spec's Phase 1 invites ship, each booked row here can gain a "Join" action pointing at `/join`. Nothing here blocks or duplicates that work.

---

## 2. Product spec

### 2.1 Owner: creating and sharing

**Entry points**
- **Web:** a "Share" button in the Watchlist tab header on `/my-shows` (next to the view toggle). Visible when the watchlist has at least one show. Today `/my-shows` exists only on demo.broadwayscorecard.com (accounts are demo-only), which is where the owner tries it first (§3.8).
- **iOS:** a share icon in the To Watch tab header (`app/(tabs)/to-watch.tsx`), same visibility rule.

**First tap (no share exists yet)** opens a small sheet:

> **Share your theater plans**
> Anyone with the link can see which shows you're seeing and on which days. They don't need an account. You can stop sharing anytime.
> [x] Booked (3)
> [x] Want to see (7)
> Your name on the page: **Tom** (required, prefilled, max 30 chars)
> **[Share link]**   Preview

- **Name is required and prefilled** from the first word of the profile name. If the profile has no name (common with Apple sign-in and email sign-in), the field starts empty and Share stays disabled until it's filled. `[CHANGED: Apple/email sign-ins have no name, so the preview read "A friend's theater plans", which looks like spam — user impact]`
- **Share stays disabled with both sections off.** `[CHANGED: otherwise the owner sends a link that says "isn't being shared" — user impact]`
- **Counts in the sheet match the page** (same rules: upcoming dates only, closed shows excluded). `[CHANGED: sheet/preview said 7, page showed 5 — user impact, structure, design]`

"Share link" creates the share record and opens the platform share sheet:
- iOS app: React Native `Share.share({ url, message }, { subject })`. Tested against Messages, WhatsApp, Mail and Copy before release, since apps differ in whether they keep the text, the link or both. `[CHANGED: added subject + per-app check — user impact]`
- Web on a phone: `navigator.share({ title, text, url })`.
- Web on desktop, or when `navigator.share` is missing or fails (other than the user cancelling): copy to clipboard + toast "Link copied".
- **The link always points at broadwayscorecard.com**, even when shared from the demo site. `[CHANGED: the Lists share builds from window.location.origin, which on demo would mint demo links — own check]`

Share text: "My theater plans on Broadway Scorecard" + URL. The preview card does the rest.

**Later taps** open the same sheet with the existing link and two more controls:
- **Stop sharing**: the link stops working. Copy: "The link will stop working. Previews already sent in chats stay visible there." `[CHANGED: iMessage keeps the preview card on the recipient's phone — user impact, pre-mortem]`
- **Reset link**: old link dies, new link minted. Confirm dialog: "Anyone with the old link will lose access."

Toggles and name save on change.

**Hiding individual shows is V2** (owner decision 2026-10-01). The pre-mortem showed that date + venue + the show page's weekly schedule roughly pins down when the owner is out, and the live link keeps showing every new booking. The owner accepted that for V1; the controls are the section toggles, stop and reset.

### 2.2 Viewer: the plans page

**URL:** `https://broadwayscorecard.com/plans/<token>`. Opens in the browser for everyone in V1, including people who have the iOS app (no universal-link claim yet, §3.6).

**Layout (mobile first, design-system components only):**
1. Header: "**Tom's theater plans**", subline "Broadway Scorecard".
2. **Booked** (if enabled and non-empty): rows ordered by date. Each row: poster, title, venue, ScoreBadge, date chip ("Sat, Oct 18"), and "Add to my calendar".
3. **Want to see** (if enabled and non-empty): ordered as on the owner's watchlist, newest first. Each: poster, title, ScoreBadge, status pill ("In previews", "Opens Mar 12").
4. Footer: a plain "Make your own list on Broadway Scorecard" link to the homepage. The real nudge is V2.

`[CHANGED: dropped the "Updated live" subline; people read it as covering the preview card, which iMessage never refreshes — user impact]`

**Row tap** → `/show/<slug>`. Catalog-only shows (off-Broadway/regional imports) go to `/diary-show/<slug>`, the same rule the calendar builder uses.

**Add to my calendar** (booked rows): "Apple / Outlook" (downloads an all-day `.ics`) and "Google Calendar". Event title is the show title (the calendar module adds 🎭 itself); "With Tom" goes in the event description through the existing companions field. Apple first on iPhone/Mac, Google first elsewhere. `[CHANGED: Apple option now works on prod for all-day events (§3.4); first draft hid it, leaving iPhone friends a Google web link that asks them to sign in — user impact. Title fixed: the builders already add 🎭, the draft would have shown it twice — user impact, design]`

**What's included** — the same rules the owner's own app uses (`lib/watchlist-slot.ts` in the iOS app), so the friend's page matches the owner's To Watch tab: `[CHANGED: first draft used "planned_date is null" for Want to see, which dropped re-booked and already-seen shows that the app files under Not Yet Booked — structure]`
- **Booked** = watchlist shows with a date of today or later, **today being the date at the show's venue** (New York for Broadway, London for the West End), not the viewer's. `[CHANGED: viewer-local filtering hid tonight's NYC show from a friend in Tokyo — structure]`
- **Want to see** = watchlist shows with no date, plus shows whose past date is already logged in the diary (the app's "not-booked" rule). Closed shows are left out: a friend can't join them.
- **Left out entirely:** past dates that haven't been logged yet (the owner's private "to be rated" list), curtain times, ratings, review text, user id, email, avatar.
- **Not included in V1:** future-dated diary entries (reviews with a future "date seen"). Both apps list these under Upcoming in the diary/Watched view (iOS `app/(tabs)/watched.tsx:334`, web `MyShowsClient.tsx:439`), but not on the To Watch shelf, which is what this page mirrors. They're rare (import back-dating), and exposing review rows from a public function widens what it touches. Revisit if the owner logs plans that way. `[CHANGED: considered and declined — structure raised it]`

**States**
| State | What the viewer sees |
|---|---|
| Valid, has shows | The page above |
| Valid, nothing left after filtering | "Tom has nothing planned right now." + link to what's playing |
| Unknown token, sharing stopped, or link reset | One identical "This list isn't being shared right now" page. `noindex`. HTTP 404. |
| Database unreachable | "Couldn't load these plans. Try again in a minute." HTTP 503, not a 404, so a blip doesn't look like the owner turned sharing off. `[CHANGED: error path was unspecified — Gemini, GPT]` |

**Link preview (iMessage/WhatsApp card):** title "Tom's theater plans", description "3 upcoming · 7 not yet booked" (same counts and section names as the page), image with the name and up to 4 posters. Built from the token on the server; nothing on it comes from URL parameters.

### 2.3 Privacy rules (product level)

- The sheet says it plainly: anyone with the link sees which shows and which days.
- Dates are shown, times are not.
- The name shown is the owner's choice. The page never shows the full Google/Apple profile name unless they type it.
- The link is unguessable (122-bit random token), not indexed, and can be stopped or reset at once.
- The token is scrubbed from every analytics tool, and session recording is off on the page (§3.5). `[CHANGED: PostHog autocapture, session replay, GA, Vercel Analytics and Sentry all record full URLs, so the token would have landed in five third-party dashboards — pre-mortem, structure]`
- Ratings, reviews and diary history are never part of the share.

---

## 3. Technical plan

### 3.0 Shape in one paragraph

One owner-only table (`plan_shares`) holds the token and settings. One SECURITY DEFINER function (`get_shared_plans`) is the only public read path and returns raw rows. The **web server** turns those rows into the page: it resolves shows from the build's own data, applies one pure selection module (`selectSharedPlans`) and renders. The client component only displays. The preview image sits next to the page and reuses the same loader. iOS ports the same selection module for its counts. `[CHANGED: first draft did show resolution and filtering in the browser (a fourth copy of the lookup chain, a 5 MB fetch) and put the preview in the stateless /api/og route — design P1-a, P1-b]`

### 3.1 Data model (one migration)

`supabase/migrations/20261001_plan_shares.sql`:

```sql
CREATE TABLE plan_shares (
  user_id          UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  token            TEXT NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{32}$'),
  enabled          BOOLEAN NOT NULL DEFAULT true,
  show_booked      BOOLEAN NOT NULL DEFAULT true,
  show_unbooked    BOOLEAN NOT NULL DEFAULT true,
  display_name     TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 30),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE plan_shares ENABLE ROW LEVEL SECURITY;
-- Owner-only, all four verbs. No anon policy: the public path is get_shared_plans().
CREATE POLICY "own plan share select" ON plan_shares FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own plan share insert" ON plan_shares FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own plan share update" ON plan_shares FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own plan share delete" ON plan_shares FOR DELETE USING (auth.uid() = user_id);
```

**Token is minted only in the database** `[CHANGED: the owner UPDATE policy let a client write any 32-hex token, e.g. all zeros — structure]`: a `BEFORE INSERT OR UPDATE` trigger (`plan_shares_guard`, SECURITY INVOKER, `SET search_path = ''`) sets `NEW.token` to a fresh `replace(gen_random_uuid()::text, '-', '')` on INSERT, and on UPDATE forces `NEW.token := OLD.token` unless the transaction-local setting `bsc.rotate_token` is `'1'`. It also bumps `updated_at` and trims `display_name`.

**Rotate:** `rotate_plan_share_token() RETURNS TEXT` (SECURITY INVOKER, so RLS still limits it to the caller's row): `set_config('bsc.rotate_token','1',true)`, update the token, return it.

**Grants** `[CHANGED: Postgres grants EXECUTE to PUBLIC by default — structure; matches 20260422_security_advisor_fixes.sql]`:
```sql
REVOKE ALL ON FUNCTION public.get_shared_plans(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_plans(TEXT) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_plan_share_token() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_plan_share_token() TO authenticated;
```

Notes:
- One row per user. "Live" means the row points at the user's watchlist; nothing is copied.
- Stop sharing = `enabled = false`. Sharing again after a stop mints a new link (`ensure` calls `rotate_plan_share_token`), so the stopped link stays dead for whoever had it. `[CHANGED 2026-10-03: ship-check — the old "re-enabling keeps the same link" quietly revived a link the owner had been told no longer works]`
- `watchlist` and `profiles` RLS are untouched.
- `display_name` is copied into `plan_shares` at creation and is `NOT NULL`, so the public function never reads `profiles` at all. `[CHANGED: removes the profile-name fallback and the "A friend" spam-looking state — user impact; simplifies the function]`
- Light brand guard at write time: the owner UIs refuse names containing "broadway scorecard" or "scorecard" (case-insensitive); the database CHECK only enforces length. `[CHANGED: a name is printed on a branded preview card — structure]`

### 3.2 Public read path: `get_shared_plans(p_token)`

`LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''`. Returns `JSONB` or `NULL`.

- `p_token` must match `^[a-f0-9]{32}$`, otherwise `NULL` without touching a table.
- Share row must exist, be `enabled`, and have at least one section on; otherwise `NULL`. Unknown, disabled, reset and malformed are indistinguishable.
- Returns **raw rows**, no date logic beyond a coarse floor:
  ```json
  {
    "name": "Tom",
    "showBooked": true, "showUnbooked": true,
    "entries": [
      { "show_id": "wicked-2003", "planned_date": "2026-10-18", "logged": false },
      { "show_id": "maybe-happy-ending-2024", "planned_date": null, "logged": false }
    ]
  }
  ```
  - `entries`: the owner's watchlist rows with `planned_date IS NULL OR planned_date >= current_date - 2` **or** whose past date is already logged. `logged` = a review for that show exists with `date_seen >= planned_date` or with no `date_seen` (the iOS `classifyWatchlistEntry` rule). This is the only fact read from `reviews`, and only as a boolean. Cap 300 rows. `[CHANGED: needed for parity with the app's buckets — structure]`
  - Ordered by `created_at DESC` (the owner's watchlist order); `created_at` itself is not returned.
  - A section switched off is filtered in the function too, so its rows never leave the database. *(As built, 2026-10-01.)*
- Never selects `curtain_time`, `time_slot`, `user_id`, `id`, `created_at`, review rows, or anything from `profiles`.
- The precise booked/unbooked split happens in `selectSharedPlans` (§3.3), because "today" depends on the show's venue timezone, which the database doesn't know.

**Apply:** land the migration, wait for the land run to put it on main (the apply workflow reads the file from main), then dispatch `apply-migration.yml` (`migration=supabase/migrations/20261001_plan_shares.sql`, `confirm=APPLY`) **in the same sitting**. `verify-schema.yml` and the pre-deploy schema gate derive their expectations from migration files automatically (`scripts/lib/supabase-schema-expectations.js`), so they go red from the moment the file lands until it's applied. No manual registry edit. `[CHANGED: first draft proposed editing a list that doesn't exist — design P2-c, structure]`

**Rollback:** revert app code first, confirm live, then land a `DROP` migration (not a hand-run DROP, or the schema verifier fails forever). `[CHANGED: structure]`

**SQL test loop** `[CHANGED: avoid a land → dispatch → wait loop per SQL fix — structure]`: develop the migration against a throwaway local Postgres (PostgreSQL 16 via `scripts/test-plan-shares-sql.sh`, with stub `auth.uid()` / `profiles` / `watchlist` / `reviews`), with a test script covering every bucket rule, trigger and grant. Then the CI round-trip (`test-ugc-roundtrip.yml` pattern) runs the same cases against the real project after apply.

### 3.3 Web: viewer page `/plans/[token]`

New files:
- `src/lib/shared-plans/load.ts`: `loadSharedPlans(token)`, wrapped in React `cache()`. Calls the RPC with the existing `getServerSupabaseClient()`, passing `global.fetch` with `cache: 'no-store'` so Next's fetch cache can never freeze a stopped share. `[CHANGED: Next 14 caches fetches in route handlers by default and the Data Cache survives deploys, which would have frozen previews permanently — pre-mortem]` Distinguishes `null` (not shared → 404) from a thrown error (→ 503 state).
- `src/lib/shared-plans/resolve.ts` (server-only): ids → display rows using the build's own data, the same chain `/diary-show/[id]` uses on the server: `getShowById` (data-core), then `getDiaryShowById` / `getShowStubById` (`src/lib/diary-show.ts`). Output per show: title, slug, href, poster, score, status, venue, category, theater address, runtime. `[CHANGED: replaces client-side show-lookup.json + 5 MB diary-lookup.json + per-show JSON fetches; drops the decodeShowLookup extraction, which turned out to be two different decoders — design P1-a, structure]`
- `src/lib/shared-plans/select.ts`: **pure** `selectSharedPlans(payload, shows, now)` → `{ booked: [...], unbooked: [...], counts }`. Applies venue-timezone "today" (`resolveTimeZone(category)` from `src/lib/calendar/timezone.ts`), the logged rule, closed-show exclusion, section toggles. Used by the page, the preview image and the web owner sheet's counts. Unit-tested with `node:test`, including a 23:30 New York show viewed from Tokyo, a West End show around the UK clock change, and a re-booked show. `[CHANGED: one rule instead of three — design P2-b, structure, user impact]`
- `src/app/plans/[token]/page.tsx`: `dynamic = 'force-dynamic'`. Loads, resolves, selects, renders `SharedPlansView`. Metadata: `robots: { index: false, follow: false }`, `referrer: 'no-referrer'`, title/description from the selected counts.
- `src/app/plans/[token]/opengraph-image.tsx`: same loader + selection, 1200×630 card with the name, counts and up to 4 posters, same pattern as `src/app/show/[slug]/opengraph-image.tsx`. `dynamic = 'force-dynamic'`. Unknown token → generic site card. `[CHANGED: leaves /api/og a pure parameter renderer — design P1-b]`
- `src/app/plans/[token]/not-found.tsx`: the neutral "isn't being shared" state.
- `src/app/plans/[token]/SharedPlansView.tsx`: client component, display only. `ShowListCard` / `MiniShowCard`, `ScoreBadge`, status pill from `show-cards`. Fires analytics (§3.5).
- **Dates** are formatted from the `YYYY-MM-DD` string with `timeZone: 'UTC'` on a UTC-midnight date, so no server or viewer timezone can shift "Sat, Oct 18" to Friday. Unit-tested. `[CHANGED: user impact]`
- **Caching:** `force-dynamic` already makes the response `no-store`. The prod smoke test checks the live header rather than adding config in `next.config.js`. `[CHANGED: design P2-d, structure]`
- **Not feature-flagged.** The page 404s for every token until a share row exists, and creating one needs the owner UI.

### 3.4 Calendar reuse

- `src/lib/calendar-event.ts`: `buildPlannedShowEvent(show, entry, { allDay?: boolean, companions?: string[] })`. With `allDay`, a missing `curtain_time` gives `time: null` instead of `null` for the whole event. The ICS builder already writes all-day events (`ics.ts:144`) and both builders add 🎭 and render `companions`. `[CHANGED: replaces a sibling builder that duplicated href/location logic and doubled the emoji — design P1-c]`
- `src/components/user/AddToCalendarButtons.tsx`: the `featureFlags.calendarExport` check moves out to its three existing callers (`ShowHeroRedesign`, `ShowPageWatchlistButton`, `MyShowsClient`). The plans page renders it unconditionally. No new props. `[CHANGED: two override props → four render modes — design P2-a]`
- `src/app/api/calendar.ics/route.ts`: serve **all-day** events (no `t` param) regardless of `CALENDAR_EXPORT_ENABLED`; timed events keep the env gate. The gate exists to contain timezone bugs in timed `.ics` files, and all-day events contain no timezone. Route test for both cases. `[CHANGED: Apple Calendar was missing on prod, so iPhone friends got only a Google web link; the owner has no Vercel env access to flip the var — user impact, Gemini]`

### 3.5 Analytics, without leaking the token

- `src/lib/analytics/redact-url.ts`: `redactSharedPlanUrl(url)` turns `/plans/<anything>` into `/plans/:token` in absolute URLs, paths and referrers. Wired into every tool `AnalyticsWrapper.tsx` starts: PostHog `before_send` (rewrites `$current_url`, `$pathname`, `$referrer`, `$initial_*`), Vercel `<Analytics beforeSend>` and `<SpeedInsights beforeSend>`, GA `page_location`/`page_referrer`, Sentry `beforeSend` (request URL + breadcrumbs). Session recording is stopped on `/plans/*` (`posthog.stopSessionRecording()` on mount). `[CHANGED: pre-mortem primary scenario]`
- **Prevention test:** a unit test feeds a sample event through each configured hook and fails if the 32-hex token survives anywhere. A grep test fails if `AnalyticsWrapper.tsx` gains a new analytics init that doesn't route through the redactor.
- Events (dual-fire `track()` + `captureEvent()`): owner `plans_share_enabled`, `plans_shared` (native-sheet / copy), `plans_share_stopped`, `plans_link_reset`; viewer `plans_page_viewed` (fired on mount: link-preview crawlers don't run JavaScript, so there's no bot inflation and no undercount of people who read without scrolling), `plans_show_tapped`, `plans_calendar_added` (google / ics). `[CHANGED: the first draft gated views on scroll, undercounting the main V2 metric — structure]`

### 3.6 Owner UI

**Web**
- **Client contract (as built):** create with an upsert (`on_conflict=user_id`) that always includes `display_name` (Postgres checks NOT NULL before resolving the conflict); change settings with PATCH; never send `token`; call `get_shared_plans` with POST (it is VOLATILE so PostgREST refuses GET and the token never sits in a URL).
- `src/hooks/usePlanShare.ts`: `share` (current row or null), `ensure({ displayName, showBooked, showUnbooked })` → URL, `update(patch)`, `rotate()` → URL (via existing `supabaseRestRpc`). Stop sharing is `update({ enabled: false })`. Returns URLs built from `BASE_URL`. The iOS hook exposes the same method names. `[CHANGED: one method set on both platforms; follows useUserLists.shareList returning a URL — design P2-e]`
- `src/components/user/SharePlansModal.tsx` on the shared `Modal`. Counts come from `selectSharedPlans` run on the owner's own watchlist + reviews.
- `src/lib/share-link.ts`: `shareOrCopy({ title, text, url })` → `'shared' | 'copied' | 'cancelled'`. Migrate **both** existing inline copies (ListsTab share, `BeatTheCriticsClient.tsx:440`) in the same change. `[CHANGED: design P2-f]`
- Mounted in the Watchlist tab header of `MyShowsClient.tsx` (already behind `userAccounts`).

**iOS** (`BroadwayScorecard-app`)
- `lib/shared-plans-select.ts`: port of `selectSharedPlans` with a header naming the web source, same as the app's other ports. Reuses `lib/watchlist-slot.ts` for the logged rule.
- `hooks/usePlanShare.ts`: same methods against the app's Supabase client.
- `components/user/SharePlansSheet.tsx`: bottom sheet in the `PlannedDateSheet` style. Share via `Share.share({ url, message }, { subject })`.
- Header button in `app/(tabs)/to-watch.tsx`.
- Gated by a new `planSharing` flag in `app.json` `extra.features` (read by `lib/feature-flags.ts`). It ships off; turning it on is a one-line OTA after the web-first trial (§3.8). `[CHANGED: an OTA on the production channel reaches every app user at once — user impact, structure]`
- **No universal-link change.** `/plans/*` stays out of the AASA file until the app has a screen for it.

### 3.7 Testing and verification

| Layer | Test |
|---|---|
| SQL (local Postgres, then CI round-trip) | Share creation mints a token; client-written token ignored on insert and update; rotate works only for the owner and only for `authenticated`; anon can't call rotate; RPC returns NULL for disabled / rotated / malformed / both-sections-off; payload has no `curtain_time`, `user_id`, `created_at` keys; logged rule matches `watchlist-slot` fixtures; other users can't read or write the row |
| Pure libs | `selectSharedPlans` (venue timezone, logged rule, closed shows, toggles, counts), `redactSharedPlanUrl` + the hooks test, `shareOrCopy` (shared / AbortError / missing / throws), date formatting, `buildPlannedShowEvent` all-day + companions |
| Route | `/api/calendar.ics`: all-day served with env unset; timed still 404 with env unset |
| Web UI | Playwright fixture for `/plans/[token]` (populated, empty, not shared, 503) and the owner modal; `/visual-qa` at 375 and 1280 px |
| Parity | One shared fixture file (watchlist + reviews + today) checked in both repos; the web test and the iOS test must give the same buckets |
| Prod smoke (owner + Claude) | Owner shares from demo; Claude opens the link logged out and checks: 200 with `no-store`, the preview card in iMessage/WhatsApp/Mail, a tap through to a show, one all-day Apple and one Google calendar add, no token in PostHog's live events; stop sharing → 404 page |

### 3.8 Rollout order `[CHANGED: web-first trial before any iOS release — structure, user impact; Phase 0 ramp]`

1. **Database.** Migration developed against local Postgres → land → apply in the same sitting → CI round-trip green.
2. **Viewer page + preview + calendar route + analytics redaction** → land. Invisible until a share row exists.
3. **Web owner modal** → land. Reachable only on the demo site.
4. **Trial (the "by hand" increment):** the owner creates their share on the demo site and texts it to their partner. Claude runs the prod smoke checks. Fixes here are cheap: one web deploy, no app release.
5. **iOS sheet** behind `planSharing` (off) → push to app `main` → TestFlight build (`force_build=true`) so the owner can try it with the flag on in a dev build.
6. **Flip `planSharing` on** in the app → OTA.

Each step can be reverted on its own. Steps 2–3 do nothing without step 1, and step 6 is a single line.

### 3.9 V2 backlog

- Sign-up nudge for viewers, measured against `plans_page_viewed`.
- Hide individual shows from the share (owner chose V2; pre-mortem's main privacy control). Store as `plan_shares.hidden_show_ids TEXT[]`, filtered inside `get_shared_plans`, with a "Hide from shared plans" item in each platform's existing per-show menu.
- "Viewed N times this week" for the owner (pre-mortem suggestion).
- Optional link expiry / booked-date horizon.
- `/plans/*` universal link with an in-app screen.
- "I'm interested" per show; per-show notes ("spare ticket").
- "Join" on booked rows once diary-sharing Phase 1 (`/join`) ships.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| Forwarded link becomes a standing feed of when the owner is out | Plain warning, date only, section toggles, instant stop/reset; per-show hide in V2 |
| Token leaks through analytics or session replays | `redactSharedPlanUrl` in all five tools, replay off on the route, hook test |
| Stopped share still served from a cache | `no-store` fetch in the loader, `force-dynamic` page and preview, live-header smoke check |
| Friend's page disagrees with the owner's app | One selection rule, ported to iOS, shared parity fixture |
| A future column leaks | Public access only through an explicit-field function; no anon policy on `plan_shares`, `watchlist` or `reviews` |
| Fake branded cards | Card reads only the token; names are length-checked and brand-guarded |
| App users get a half-tested button | `planSharing` flag, web-first trial |

---

## 5. Plan review record (2026-10-01)

**Coverage:** GPT lens on `gpt-5.4-mini` via the OpenAI API (Codex CLI is not installed in cloud; no repository access for this reviewer). Gemini 2.5 Flash ran. Four Claude reviewers ran with repository access: structure and devil's advocate, pre-mortem, user impact, code design. `/right-problem` was not run; the owner settled the product shape directly in a question round.

**Phase 0 (framing):** first execution unit is 1 user (the owner), so the scope is already minimal. The ramp did change: a by-hand trial from the demo site comes before any app release (§3.8 step 4).

**Consensus (2+ reviewers):**

| Issue | Raised by | Severity | Fix |
|---|---|---|---|
| Preview/sheet counts disagree with the page | User impact, structure, design | P1 | One `selectSharedPlans` (§3.3) |
| Web owner UI has no prod users (accounts demo-only) | GPT, structure | P1 | Sequenced as the demo-site trial, not cut (§3.8) |
| iOS OTA reaches every user before the owner's test | User impact, structure | P1 | `planSharing` flag (§3.6) |
| Calendar on prod is Google-only for iPhone friends | User impact, Gemini | P1 | All-day `.ics` ungated (§3.4) |
| Double 🎭 in event titles; sibling builder | User impact, design | P1 | Relax `buildPlannedShowEvent`, use `companions` |
| Token/URL leakage via analytics | Pre-mortem, structure, GPT | P0 | §3.5 |
| Missing error path (DB down = 404) | Gemini, GPT | P2 | 503 state (§2.2) |

**Sharpest solo findings:** bucket-rule mismatch with the app's Not Yet Booked shelf (structure); Next's fetch cache freezing previews across deploys (pre-mortem); venue-timezone "today" instead of viewer-local (structure); client could write a weak token through the owner UPDATE policy (structure).

**Declined:** dropping the custom preview card (GPT): the card is what makes a shared link read as an invitation in iMessage. Optimistic locking for web+iOS edits of the same row (GPT): one owner, last write wins is acceptable. Future-dated diary entries in Booked (structure): see §2.2.

**Effort:** first draft ≈ 3 sessions. Revised ≈ 4 (database + tests 1, viewer page + preview + calendar + redaction 1.5, web owner 0.5, iOS 1). Per-show hiding deferred to V2 by the owner.
