# Spec: Share My Theater Plans

**Status:** Proposed. Spec + technical plan, pre-build.
**Linear:** BRO-4481
**Author:** Claude (session 2026-10-01), from owner request
**Scope:** Web (Next.js on Vercel) and iOS (`BroadwayScorecard-app`, Expo)

---

## 1. Brief

**The ask (owner, 2026-10-01):** "I want to be able to share out my list of upcoming shows with friends, so they can see what shows they might want to join with me, or just see what shows I haven't booked yet on my watchlist. From the web version and the iOS version. So it needs a share sheet." Follow-up: "Others should not need to log in to see my list. BUT they should have some light encouragement to make their own account. V2 for that."

**What we build:** one link per person that shows their theater plans. Two sections:

- **Booked**: shows with a date, soonest first. Date only, no curtain time.
- **Want to see**: watchlist shows with no date yet.

The owner taps **Share** on the watchlist (web: My Shows → Watchlist; iOS: To Watch tab). The share sheet opens with the link (iMessage, WhatsApp, Mail, copy). A friend opens it in any browser, no account needed, and sees the list with posters and scores. They can tap a show to read about it, or add one of the owner's booked dates to their own calendar.

**Why it matters:** today the only way to tell a friend "here's what I'm seeing, come along" is screenshots. A live link stays current without resending, and every opened link is a visitor landing on a page full of scored shows. That second point becomes a growth loop in V2, when the page starts inviting viewers to make their own list.

**Owner decisions (2026-10-01, via question round):**

| Question | Answer |
|---|---|
| What's on the page | Both sections, and the owner can switch either one off |
| Date detail for booked shows | Date only (no time) |
| Link behaviour | Live: one link, always current; can be turned off or reset |
| What viewers can do (V1) | Tap through to show pages; add a booked date to their calendar |
| Sign-up nudge for viewers | V2 |

**Out of V1:** "I'm interested" taps, hiding individual shows, per-show notes, opening the link inside the iOS app, sign-up nudge, follower/friend graph.

### Relation to the existing diary-sharing spec

`docs/specs/diary-sharing-and-calendar.md` covers a *different* object: an invite to **one** dated performance ("join me at Wicked on Oct 18"), with join-into-your-diary semantics that need the viewer to sign in. This spec is the **whole list**, read-only, anonymous. They compose: once Phase 1 invites ship, each booked row on the plans page can gain a "Join" action pointing at that spec's `/join` flow. Nothing here blocks or duplicates that work. This spec reuses its calendar module (`src/lib/calendar/`) unchanged.

---

## 2. Product spec

### 2.1 Owner: creating and sharing

**Entry points**
- **Web:** a "Share" button in the Watchlist tab header on `/my-shows` (next to the view toggle). Visible only when the watchlist has at least one show.
- **iOS:** a share icon in the To Watch tab header (`app/(tabs)/to-watch.tsx`), same visibility rule.

**First tap (no share exists yet)** opens a small sheet:

> **Share your theater plans**
> Friends can see these shows without signing in. Booked shows show the date, not the time.
> [x] Booked (3)
> [x] Want to see (7)
> Name shown: **Tom** (editable, max 30 chars, defaults to first word of profile name)
> **[Share link]**   Preview

"Share link" creates the share record and immediately opens the platform share sheet:
- iOS app: React Native `Share.share({ message, url })`.
- Web on a phone: `navigator.share({ title, text, url })`.
- Web on desktop, or when `navigator.share` is missing or throws (not user-cancel): copy to clipboard + toast "Link copied". Existing pattern in `ListsTab.tsx`.

Share text: "My theater plans on Broadway Scorecard" + URL. No date list in the message body; the link preview card does that work.

**Later taps** open the same sheet with the existing link and two extra controls:
- **Stop sharing**: link stops working at once (page shows "This list isn't being shared right now").
- **Reset link**: old link dies, new link minted. Confirm dialog: "Anyone with the old link will lose access."

Toggles and name save on change. Both toggles off = sharing effectively paused; the page shows the "not shared" state rather than an empty page.

### 2.2 Viewer: the plans page

**URL:** `https://broadwayscorecard.com/plans/<token>`. Opens in the browser for everyone in V1, including people who have the iOS app (no universal-link claim yet, see §4.6).

**Layout (mobile first, design-system components only):**
1. Header: "**Tom's theater plans**", subline "Updated live · Broadway Scorecard".
2. **Booked** section (if enabled and non-empty): rows ordered by date ascending. Each row: poster, title, venue, ScoreBadge, date chip ("Sat, Oct 18"), and an "Add to my calendar" action.
3. **Want to see** section (if enabled and non-empty): poster grid or rows, ordered as on the owner's watchlist (newest first). Each: poster, title, ScoreBadge, status pill (e.g. "In previews", "Opens Mar 12").
4. Footer: small "Make your own list on Broadway Scorecard" link to the homepage. Plain text only in V1; the real nudge is V2.

**Row tap** → `/show/<slug>` (the normal show page with tickets, reviews, scores). Catalog-only shows (off-Broadway/regional imports, `diaryOnly`) go to `/diary-show/<slug>`, the same rule `buildPlannedShowEvent` uses.

**Add to my calendar** (booked rows only): small menu with "Apple / Outlook" (the existing `/api/calendar.ics` route, all-day event) and "Google Calendar" (template URL). Event title: "🎭 <Show> (with Tom)". Description links to the show page and the plans page. Ordered Apple-first on iOS/macOS, Google-first on Android (existing calendar spec rule).

**What's filtered out**
- Booked dates earlier than today (viewer's local date). Yesterday's show is history, and "seen but not rated" entries are the owner's private diary.
- Want-to-see shows that have closed. A friend can't join a closed show, and a stale wishlist entry makes the page look dead.
- Curtain time, rating, review text, user id, email, avatar: never sent to the viewer at all (enforced in the database function, §3.2).

**States**
| State | What the viewer sees |
|---|---|
| Valid, has shows | The page above |
| Valid, both sections empty after filtering | "Tom has nothing planned right now." + link to browse what's playing |
| Unknown token, sharing stopped, or link reset | One identical "This list isn't being shared right now" page (no way to tell which). `noindex`. HTTP 404. |

**Link preview (iMessage/WhatsApp card):** title "Tom's theater plans", description "3 booked · 7 want to see", image: generated card with the name and up to 4 posters. Built from the token server-side, so nobody can mint a fake branded card by editing URL params.

### 2.3 Privacy rules (product level)

- The sheet says plainly: "Anyone with the link can see these shows and dates."
- Dates are shown, times are not (owner decision).
- Name shown is the owner's choice (defaults to first name only, never the full Google/Apple profile name).
- Link is unguessable (122-bit random token), not indexed by search engines, and can be killed or reset instantly.
- Ratings, reviews and diary history are never part of the share.

---

## 3. Technical plan

### 3.1 Data model (one migration)

`supabase/migrations/20261001_plan_shares.sql`:

```sql
CREATE TABLE plan_shares (
  user_id        UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  token          TEXT NOT NULL UNIQUE
                   DEFAULT replace(gen_random_uuid()::text, '-', '')
                   CHECK (token ~ '^[a-f0-9]{32}$'),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  show_booked    BOOLEAN NOT NULL DEFAULT true,
  show_unbooked  BOOLEAN NOT NULL DEFAULT true,
  display_name   TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 30),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plan_shares ENABLE ROW LEVEL SECURITY;
-- Owner-only, all four verbs. No anon policy at all: the public read path is the RPC below.
CREATE POLICY "own plan share select" ON plan_shares FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own plan share insert" ON plan_shares FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own plan share update" ON plan_shares FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own plan share delete" ON plan_shares FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER plan_shares_updated_at BEFORE UPDATE ON plan_shares
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
```

Design notes:
- **One row per user** (PK on `user_id`). "Live link" means the row points at the user's watchlist; no snapshot copies.
- **Token format is pinned by CHECK** (32 lowercase hex = 122 random bits). A client cannot write a short guessable token even though it owns the row. The existing Lists feature uses an 8-char slug (32 bits); that is acceptable for public lists but not for a page that reveals dates someone will be out of the house.
- **Reset** = `rotate_plan_share_token()` RPC (SECURITY INVOKER is enough; it updates the caller's own row via RLS and returns the new token) so the token is always minted in the database, never in client code.
- **Stop sharing** = `enabled = false` (keeps the row, so re-enabling keeps the same link unless the owner resets). Delete is allowed but no UI uses it.
- `watchlist` RLS is untouched. Nothing anon can read `watchlist` directly.

### 3.2 Public read path: one SECURITY DEFINER function

```sql
CREATE FUNCTION public.get_shared_plans(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$ ... $$;
GRANT EXECUTE ON FUNCTION public.get_shared_plans(TEXT) TO anon, authenticated;
```

Behaviour:
- Validates `p_token ~ '^[a-f0-9]{32}$'` before touching any table; malformed → `NULL`.
- Looks up `plan_shares` where `token = p_token AND enabled`; none, or both sections off → `NULL`. Unknown, disabled, reset and malformed are indistinguishable.
- Returns:
  ```json
  {
    "name": "Tom",
    "booked":   [{ "show_id": "wicked-2003", "date": "2026-10-18" }],
    "unbooked": [{ "show_id": "maybe-happy-ending-2024" }]
  }
  ```
  - `name` = `display_name`, else the first whitespace-delimited word of `profiles.display_name`, else `NULL` (page renders "A friend's theater plans").
  - `booked`: watchlist rows with `planned_date >= (now() AT TIME ZONE 'UTC')::date - 1`, ordered by date, cap 100. The 1-day slack lets a viewer west of UTC still see tonight's show; the client then drops anything before the viewer's local today.
  - `unbooked`: rows with `planned_date IS NULL`, ordered `created_at DESC`, cap 200. `created_at` itself is not returned.
  - A section switched off is returned as `[]`, never omitted (stable shape for both clients).
- Never selects `curtain_time`, `time_slot`, `user_id`, `id`, `created_at`, or anything from `reviews`.
- Lesson applied from `20260422b_fantasy_entries_pii_fix.sql`: a masked RPC instead of an anon SELECT policy, so a future column added to `watchlist` or `profiles` can't leak through `select=*`.

Filtering closed shows is **client-side** (§3.3): show status lives in `public/data/show-lookup.json`, not the database.

**Apply + verify:** commit the migration, land it, dispatch `apply-migration.yml` (`migration=supabase/migrations/20261001_plan_shares.sql`, `confirm=APPLY`). Add `plan_shares` + `get_shared_plans` to the required-schema list in `scripts/verify-supabase-schema.js` so a deploy fails if the migration ever goes missing. Round-trip test via the `test-ugc-roundtrip.yml` pattern (CI holds the Supabase credentials; the cloud sandbox does not).

### 3.3 Web: viewer page `/plans/[token]`

Files:
- `src/app/plans/[token]/page.tsx`: server component. `export const dynamic = 'force-dynamic'`. One `cache()`-wrapped loader calls `get_shared_plans` via `getServerSupabaseClient()` (anon key) and is shared by `generateMetadata` and the page, so it's one RPC per request. Metadata: `robots: { index: false, follow: false }`, OG/Twitter per §2.2, `openGraph.images = /api/og?type=plans&token=<token>`. `null` result → `notFound()`, and `src/app/plans/[token]/not-found.tsx` renders the neutral "isn't being shared" state.
- `src/app/plans/[token]/SharedPlansClient.tsx`: client component, receives the RPC payload as props (no client-side RPC), then:
  1. Fetches `/data/show-lookup.json`, resolves ids; for misses, falls back to `/data/diary-lookup.json` (same two-step the diary uses in `MyShowsClient.tsx:346`).
  2. Drops booked rows with `date < viewer local today`, and unbooked rows whose status is `closed`.
  3. Renders with `ShowListCard` / `MiniShowCard`, `ScoreBadge`, `StatusBadge` (design-system rule). No new card styles.
- **Shared decoder:** `decodeShowLookup` is currently duplicated (`SharedListClient.tsx`, `MyShowsClient.tsx`). Extract it to `src/lib/show-lookup-decode.ts`, wire both existing callers to it, and use it here (CLAUDE.md §15: extract, export, wire back). Unit test against a real `show-lookup.json` row.
- **Response headers:** `Cache-Control: private, no-store` (set via `headers()` in `next.config.js` for `/plans/:path*`). A CDN-cached copy would keep serving a list the owner just turned off.
- **Not feature-flagged.** The page is server-rendered and demo flags evaluate to false on the server by design. It is naturally dark: it 404s for every token until someone creates a share, and creating one needs the owner UI, which is gated (§3.4).

**Calendar actions:** reuse, don't rebuild.
- `src/lib/calendar-event.ts`: add `buildAllDayShowEvent(show, date, { companion })`, a sibling of `buildPlannedShowEvent` that sets `time: null` (the ICS builder already emits `DTSTART;VALUE=DATE` all-day events, `ics.ts:144`) and titles the event "🎭 <Show> (with <name>)". Shares the href/location/duration logic with `buildPlannedShowEvent` via one private helper, so the two can't drift. Unit-tested alongside the existing one.
- `src/components/user/AddToCalendarButtons.tsx`: add two optional props, `visible?: boolean` (defaults to `featureFlags.calendarExport`, so existing callers are unchanged) and `appleEnabled?: boolean` (default `true`; when false only the Google link renders, and the compact icon falls back to Google). The plans page passes `visible` explicitly, because the demo-only `calendarExport` flag is false on prod and would hide the buttons from every friend.
- **Dependency:** `/api/calendar.ics` 404s on prod today (`CALENDAR_EXPORT_ENABLED` unset; verified 2026-10-01 with a 404 from `https://broadwayscorecard.com/api/calendar.ics`). `page.tsx` reads that env var server-side and passes `appleEnabled` down, so viewers get Google-only until the calendar feature launches, never a dead Apple button. No change to `src/lib/calendar/`.

**OG image:** extend `src/app/api/og/route.tsx` with `type=plans&token=…`. The edge route calls `get_shared_plans` through Supabase REST (`/rest/v1/rpc/get_shared_plans`, anon key, `fetch`), renders name + counts + up to 4 posters from `show-lookup.json`. An invalid token renders the generic site card. No name or count is ever taken from URL params. `Cache-Control: public, max-age=600`: a link preview being up to 10 minutes stale is fine and keeps crawler bursts cheap.

### 3.4 Web: owner UI

- `src/hooks/usePlanShare.ts`: `get()` (own row via RLS select), `enable({ showBooked, showUnbooked, displayName })` (upsert `user_id = auth.uid()`; the token comes from the column default), `update(patch)`, `stop()`, `rotate()` (RPC). Uses `supabaseRestInsert/Update` like `useWatchlist`.
- `src/components/user/SharePlansModal.tsx`: built on the shared `Modal` component. Toggles with live counts (counts come from the same three buckets `MyShowsClient` already computes: `upcomingBookedWatchlist`, `unbookedWatchlist`; counts don't apply the closed-show filter, which is fine for a label), name field, Share/Copy, Preview (opens `/plans/<token>` in a new tab), Stop sharing, Reset link.
- `src/lib/share-link.ts`: `shareOrCopy({ title, text, url })`. Tries `navigator.share`; on `AbortError` returns `'cancelled'`; on absence or other error copies to the clipboard and returns `'copied'`. Pure enough to unit-test with stubbed `navigator`. The Lists share button and Beat the Critics have their own inline versions; switch Lists over to the helper in the same change (same-class fix).
- Mount point: the Watchlist tab header in `MyShowsClient.tsx`. Already behind `featureFlags.userAccounts` because `/my-shows` is.

### 3.5 iOS app (`BroadwayScorecard-app`)

- `hooks/usePlanShare.ts`: same four operations against the app's Supabase client (`client.from('plan_shares')`, `client.rpc('rotate_plan_share_token')`).
- `components/user/SharePlansSheet.tsx`: bottom sheet in the same style as the existing `PlannedDateSheet`. Same controls as web. "Share link" → `Share.share({ message: 'My theater plans on Broadway Scorecard', url })` (iOS puts `url` in the share payload so Messages builds a rich preview).
- Header button in `app/(tabs)/to-watch.tsx`, visible when the watchlist is non-empty and the user is signed in.
- Analytics through the app's existing `lib/analytics` (`trackPlansShared`).
- Ships OTA (JS only, no native module added; `Share` is core RN). Per the app's CLAUDE.md §1b, dispatch with `force_build=true` so the owner gets a TestFlight build to try it.
- **No AASA change.** `public/.well-known/apple-app-site-association` keeps claiming only `/show/*` and `/auth/callback`, so `/plans/*` opens in Safari even for app users. Claiming it before the app has a screen for it would drop people into an app with nowhere to go.

### 3.6 Analytics

Dual-fire (`track()` + `captureEvent()`), web and app:
- `plans_share_enabled` (sections on), `plans_shared` (method: native-sheet / copy), `plans_share_stopped`, `plans_link_reset`.
- Viewer page: `plans_page_viewed` fired on first scroll or tap, not page load (iMessage and WhatsApp fetch every link for previews; counting loads would count bots); `plans_show_tapped`; `plans_calendar_added` (google / ics). No token or owner id in event props; a hashed share id is enough to count distinct lists.

These answer the V2 question: are friends opening these links and tapping through? If so, add the sign-up nudge.

### 3.7 Testing and verification

| Layer | Test |
|---|---|
| SQL | CI round-trip (`test-ugc-roundtrip.yml` pattern): user A creates share → anon RPC returns A's booked + unbooked; payload has no `curtain_time`/`user_id` keys; disabled → NULL; rotated old token → NULL; malformed token → NULL; user B can't select/update A's row; B's insert with `user_id = A` fails; past-dated row excluded; section toggle respected |
| Pure libs | `show-lookup-decode` (real row), `share-link` (share ok / AbortError / no navigator / share throws), viewer filter (past date, closed show, viewer timezone edge: 23:30 in LA on the show date still shows it) |
| Web UI | Playwright `?mock=1`-style fixture for `/plans/[token]` (populated, empty, not-shared) + owner modal; `/visual-qa` at 375px and 1280px (CLAUDE.md §5) |
| Prod smoke | After land + migration: create a share on the owner's account via the iOS TestFlight build, open the link logged out on iPhone Safari, check the iMessage preview card, tap a show, add one date to Google Calendar, stop sharing → link shows "not shared" |
| iOS | `npm run typecheck`, `npm run lint`, unit tests for the hook's payload shaping; Maestro flow for opening the sheet if an existing To Watch flow can be extended cheaply |

### 3.8 Rollout order

1. **Migration** (`plan_shares`, `get_shared_plans`, `rotate_plan_share_token`) + schema-verify entry → land → apply via `apply-migration.yml` → CI round-trip green.
2. **Web viewer page + OG + shared helpers** (`show-lookup-decode`, `share-link`) → land. Dark until a share row exists.
3. **Web owner modal** → land (demo-only today since `/my-shows` sits behind `userAccounts`).
4. **iOS sheet** → push to app `main` → TestFlight build. This is the owner's real entry point today, since web accounts are demo-only in prod.
5. **Prod smoke** (§3.7) on the owner's real account.
6. Optional, separate decision: turn on `CALENDAR_EXPORT_ENABLED` in prod so the Apple/Outlook calendar option appears on the plans page (belongs to the calendar feature's own launch).

Each step is independently revertible. Rollback for 1 = revert app code first, then `DROP FUNCTION` / `DROP TABLE plan_shares` (no other table references it).

### 3.9 V2 backlog (not built now)

- Sign-up nudge for viewers ("Make your own list in 30 seconds", app download banner), measured against `plans_page_viewed`.
- Claim `/plans/*` in AASA together with an in-app plans screen.
- "I'm interested" per show, with a notification to the owner.
- Hide individual shows from the share; per-show note ("have a spare ticket").
- "Join" on booked rows once diary-sharing Phase 1 (`/join`) ships.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| Link forwarded beyond friends reveals dates the owner is out | Date-only (no time), first-name-only default, plain warning in the sheet, instant stop/reset, unguessable token, `noindex` |
| CDN serves a list after the owner stopped sharing | `private, no-store` on `/plans/*`; OG image cache capped at 10 min |
| Future `watchlist`/`profiles` column leaks | Public access only through an explicit-column SECURITY DEFINER function; no anon policy on either table |
| Fake branded preview cards | OG reads the token, never name/count params |
| Bot traffic inflates "views" | Interaction-gated view event |
| Owner can't reach the web UI (accounts are demo-only in prod) | iOS is the V1 owner surface; web owner UI ships behind the existing flag and lights up when accounts launch |
