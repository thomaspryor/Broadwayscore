# Spec: Diary Show Sharing (Outings) + Add to Calendar

**Status:** Proposed — not yet implemented
**Author:** Claude (session 2026-08-05), from owner request
**Scope:** Web (Next.js/Vercel) first, iOS (Expo) second
**Feature flags:** `userAccounts` (existing) + new `diarySharing`

---

## 1. What we're building

Two user-facing features that share one new data model:

1. **Invite friends to a diary entry.** "I have Broad Strokes on my diary for Sep 11 — add Joanna." The owner shares a link (iOS share sheet / copy link / email); Joanna opens it, sees a rich invite page, signs in (or creates an account gracefully), and the show lands in *her* diary too, with both people shown as companions. This doubles as a viral growth loop: every invite link is an acquisition page with the show's score, an account-creation prompt, and an app-download nudge.

2. **Add to Calendar (Google + Apple).** From a diary entry, add the performance to your calendar with the real curtain time. Because diary entries today only store a *date*, this introduces a **showtime picker** (matinee vs. evening, e.g. 2:00 PM / 8:00 PM, with manual override for unusual times like 5:30).

Both features hang off a new concept: an **Outing** — "a plan to attend a specific performance (show + date + time), possibly with other people."

---

## 2. Current-state constraints (from codebase audit)

| Fact | Consequence |
|---|---|
| An "upcoming diary entry" = a `watchlist` row (`planned_date DATE`, `UNIQUE(user_id, show_id)`); reviews are `reviews` rows (`date_seen DATE`). No time-of-day column anywhere (`supabase-schema.sql:16-36`) | Time must live somewhere new; the unique constraint means a user can't have two planned dates for one show |
| `reviews`/`watchlist` RLS is strictly owner-only (`supabase-schema.sql:93-125`) | Sharing needs a new object + policies, not a loosening of existing ones |
| Proven share pattern exists: Lists — `share_slug` (random), anon read policy, `/list/[slug]` page with OG image (`useUserLists.ts:284-318`, `src/app/list/[slug]/page.tsx`) | Reuse the shape; but diary invites should use an RPC-scoped read, not a blanket anon SELECT (PII lesson from `20260422b` — see §5.3) |
| Post-sign-in resume hook exists: `deferred-auth.ts` + `PendingAction` union (`src/types/user.ts:76-87`) | "Accept invite → sign in → auto-join" is an extension of an existing mechanism, not new plumbing |
| Auth = Supabase, **Google + Apple OAuth only**; no email magic link, no phone auth | "Add by phone number" as an *auth* method is out of scope v1; phone-based invites go through the share sheet (iMessage) instead |
| Email infra exists (Resend, `noreply@broadwayscorecard.com`, `api/beat-the-critics/send-picks/route.ts`); **no SMS provider** | Email invites are cheap to add (Phase 3); SMS (Twilio + A2P registration + cost) is deferred — share sheet → Messages covers the same need free |
| Showtime data exists: `data/show-schedules.json` (42 Broadway shows, weekly matinee/evening grid with clock times, e.g. `{"m":"14:00","e":"20:00"}`) + `data/todaytix-showtimes.json` (142 BW/OB/WE shows, per-date m/e slot existence, no clock times) | The picker can be smart (real times, real slots) for covered shows, with a manual fallback for everything else |
| Site is a hybrid Next.js app on Vercel with 23 live API routes (incl. edge OG image) — *not* a static export | Server-generated `.ics` and invite metadata pages are straightforward |
| Universal Links claim only `/show/*` and `/auth/callback` (`public/.well-known/apple-app-site-association`) | Add `/join/*` so invite links open the app when installed |
| iOS app is Expo/RN; pure shared logic is vendored from `src/lib/stats/` with checksum drift detection | Calendar/ICS/time logic should be written as pure functions in that style so iOS reuses it |
| Everything user-account-related is gated by `featureFlags.userAccounts` (demo-only in prod) | New features gate behind `userAccounts && diarySharing`; ship to demo.broadwayscorecard.com first |

---

## 3. Data model

### 3.1 New tables

```sql
-- An outing: a plan to attend a specific performance, alone or with others.
CREATE TABLE outings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id       TEXT NOT NULL,               -- shows.json id OR diary-catalog id (same convention as watchlist.show_id)
  show_date     DATE NOT NULL,
  time_slot     TEXT CHECK (time_slot IN ('matinee','evening','custom')),  -- NULL = time not chosen yet
  curtain_time  TIME,                        -- local wall-clock, e.g. '19:00'; NULL until chosen
  tz            TEXT,                        -- IANA, derived from show market at creation ('America/New_York', 'Europe/London'); NULL = floating
  created_by    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invite_token  TEXT UNIQUE NOT NULL,        -- 21-char nanoid / 16+ bytes entropy, minted at creation
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE outing_members (
  outing_id  UUID NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner','guest')),
  joined_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (outing_id, user_id)
);

-- Link each member's own diary row to the outing.
ALTER TABLE watchlist ADD COLUMN outing_id UUID REFERENCES outings(id) ON DELETE SET NULL;
```

**Why a separate object instead of columns on `watchlist`:**
- `watchlist` is owner-only under RLS and consumed by existing diary/stats code on web *and* iOS (vendored reducers). Leaving its shape and policies untouched means zero regression risk for the existing diary.
- The outing is the natural unit for both features: **Add-to-Calendar needs (date + time); sharing needs (date + time + members)**. A solo user who just wants a calendar entry creates a single-member outing — same code path, no special case.
- Copy-on-join semantics (each member keeps their own `watchlist` row, pointed at the outing) mean a member's diary survives the owner deleting the outing, and each member independently rates/reviews later — reviews stay per-person and private, exactly as today.

**Sync semantics (recommendation): owner-editable, propagated.** Only the owner can change `show_date`/`curtain_time`. A Postgres trigger on `outings` UPDATE syncs every member's linked `watchlist.planned_date` — so the existing diary queries (which read `planned_date`) stay correct without any read-path change. Guests can *leave* an outing (membership row deleted; their watchlist row keeps its date but drops `outing_id`).

### 3.2 RLS + access functions

Members read their outings via a normal policy; **anonymous invite preview goes through a SECURITY DEFINER RPC, not an anon SELECT policy** (per the `20260422b` PII incident pattern — a blanket policy would expose `created_by`, member list, and token via PostgREST):

```sql
-- Members (and only members) can read the outing + membership.
CREATE POLICY "members read outings" ON outings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM outing_members m WHERE m.outing_id = id AND m.user_id = auth.uid()));
-- Owner-only UPDATE/DELETE; INSERT with created_by = auth.uid().
-- outing_members: members read; owner or self delete; inserts ONLY via join_outing().

-- Anon-safe invite preview: token in → safe fields out. No table exposure.
CREATE FUNCTION get_outing_invite(p_token TEXT)
RETURNS TABLE (show_id TEXT, show_date DATE, time_slot TEXT, curtain_time TIME, tz TEXT,
               inviter_name TEXT,            -- profiles.display_name only, never email
               member_count INT, status TEXT)
SECURITY DEFINER SET search_path = '' ...;

-- Authenticated join: validates token + status='active', inserts membership,
-- upserts the caller's watchlist row (see §3.3), returns the outing id.
CREATE FUNCTION join_outing(p_token TEXT) RETURNS UUID SECURITY DEFINER ...;
```

Rate limiting mirrors the `mezzanine_search_log` convention: cap outing creation (e.g. 30/day/user) and `get_outing_invite` lookups per IP at the API layer to blunt token scanning (the real defense is 128-bit token entropy).

### 3.3 Join edge cases

- **Invitee already has the show on their watchlist** (`UNIQUE(user_id, show_id)`): `join_outing` upserts — sets that row's `planned_date` to the outing date and links `outing_id`. (Their old solo plan is superseded; this matches user intent — they're going *with* the group.)
- **Invitee already reviewed the show:** still joins; the show appears in Upcoming again for the new date. (Seeing a show twice is currently unrepresentable in `watchlist` — the upsert rule above is the pragmatic v1 answer; a `seen-again` model is explicitly out of scope.)
- **Owner deletes the diary entry / outing:** outing → `status='cancelled'` (soft) or row delete; members' watchlist rows persist with `outing_id` nulled (`ON DELETE SET NULL`). v1: no push notification; the entry simply shows as no longer shared. (Notifying members is Phase 3.)
- **Duplicate join:** PK on `(outing_id, user_id)` — RPC is idempotent, returns success.
- **Token lifetime:** valid while `status='active'` and until `show_date + 30 days`. Owner can revoke by regenerating the token ("Reset invite link").

---

## 4. UX flows

### 4.1 Creating/upgrading an entry → outing (web, diary tab)

Entry cards in **Upcoming** gain two actions (icon row, mobile-first):

- **🕐 Set time** → showtime picker (§4.2). First use silently creates the outing (members = just you) and stores slot + curtain time.
- **👥 Invite** → creates the outing if needed, then opens the share modal:
  - **Primary: "Share invite link"** → `navigator.share({ title, text, url })` (iOS/Android share sheet: iMessage, WhatsApp, Mail, …). Desktop fallback: copy-to-clipboard (same pattern as `ListsTab.tsx:185`).
  - Secondary: **"Email an invite"** (Phase 3, Resend) — input an email address, we send a branded invite.
  - "Add by phone number" is intentionally **not** a form field: with no SMS provider and no phone auth, the honest implementation *is* the share sheet → Messages. The share modal copy acknowledges it: "Send via iMessage, WhatsApp, email — anywhere."
- Card shows companions once shared: avatar stack + "With Joanna" (display names only).

Same actions appear on the show page's diary widget and on `/diary-show/[id]` for catalog shows.

### 4.2 Showtime picker

Given `show_id` + `planned_date`, resolve in order:

1. **`show-schedules.json` weekly grid** (42 BW shows): exact chips — e.g. **"2:00 PM Matinee" / "8:00 PM Evening"** for that weekday. Days with one performance show one chip.
2. **`todaytix-showtimes.json` per-date slots** (142 shows): slot existence (m/e) is real for the *specific date*; clock time from the weekly grid if available, else market-default label ("Matinee (~2 PM)" / "Evening (~7:30 PM)").
3. **Fallback (everything else, incl. 32k catalog shows):** manual picker — quick chips `2:00 · 3:00 · 5:30 · 7:00 · 7:30 · 8:00` + native time input for anything else (`time_slot='custom'`).

Always show **"Other time…"** even when the grid matches — schedules change and special performances exist. Picker UI sits beside the existing `DatePickerButton` in the entry editor (it already handles the iOS-wheel quirks; the time input follows the same hidden-native-input pattern).

**Data plumbing:** both JSONs currently live only in the server bundle (`src/lib/data-showtimes.ts`). Add a prebuild fan-out (extend `scripts/generate-diary-data.js` or a sibling script) emitting one compact `public/data/showtimes-index.json` (~142 shows × slots ≈ small) that the client fetches lazily when the picker opens. The 10-day staleness heuristic from `ShowtimesCard.tsx:106` applies — stale grid ⇒ fall back to tier 3.

### 4.3 Invite landing page — `/join/[token]`

Server component (Node runtime): calls `get_outing_invite` via the anon server client (`supabase-server.ts` pattern), 404s on unknown/expired token.

- **`generateMetadata`:** OG image via new `type=invite` in `/api/og` — show poster + "**Tom invited you** · Broad Strokes · Thu Sep 11 · 8:00 PM". This preview *is* the viral hook in iMessage.
- **Page content (anon):** show hero (poster, ScoreBadge, venue — standard design-system components), "Tom invited you to join them", date + time, member avatars/count, and:
  - **Primary CTA: "Join this outing"** → `SignInModal` with invite-specific context copy ("Create a free account to add this to your diary — takes 10 seconds with Google or Apple"). New `PendingAction` variant `{ type: 'join-outing', token }` in `deferred-auth.ts`; after OAuth returns, the pending action fires `join_outing(token)` → redirect to `/my-shows` (diary tab) with a success toast "You're going with Tom! 🎭".
  - **Secondary CTA: "Add to calendar"** — works **without an account** (date/time/venue are already on the page). Zero-friction value for invitees who won't sign up, and the calendar entry carries the join URL so they can convert later.
  - Tertiary: link to the show page ("See reviews · 87 Critic Score").
- **Signed-in visitor:** one-tap "Join" (no modal). Already a member → "You're going! View in your diary."
- **App download encouragement:**
  - `apple-itunes-app` smart-banner meta on `/join/*` (new — doesn't exist anywhere yet; needs the App Store id in `src/config/`).
  - Add `/join/*` to `apple-app-site-association` `components` so the link opens the installed app directly.
  - Post-join success screen includes a "Get the iOS app" card (dismissible; suppressed inside the app's webview/UA).
- `robots: noindex` (same as `/diary-show/*`); tokens must not be crawlable.

### 4.4 Add to Calendar

Placement: entry card overflow + entry editor + join page + post-join success screen. If no time is set yet, the button opens the showtime picker first, then proceeds.

Two options presented (auto-ordered by platform):

1. **Apple / Outlook / everything — `.ics` download.** New route `GET /api/calendar/[outingId].ics?token=…` (token = invite token, so it works for anon invitees; also works signed-in via outing id + auth). Response `text/calendar`:
   - `DTSTART;TZID=America/New_York:20260911T200000` with an embedded static `VTIMEZONE` block for the two supported zones (`America/New_York`, `Europe/London`, from `outings.tz` via a market→tz map). Shows with unknown market/tz emit **floating** local time — correct for the dominant case (attendee is local to the show).
   - `DURATION` from the show's `runtime` field parsed with the existing helper (`src/lib/stats/parse.ts:80`; defaults 2h30m musical / 2h play) + 15 min buffer.
   - `SUMMARY: 🎭 Broad Strokes`, `LOCATION` from `theaterAddress` (741 shows) falling back to `venue + market city`, `DESCRIPTION` with companions ("With Tom, Joanna"), the show page URL, and the join link.
   - Stable `UID: outing-{id}@broadwayscorecard.com` + `SEQUENCE` bumped on outing updates, so re-downloading after a time change updates rather than duplicates.
   - On iOS Safari, tapping a `.ics` opens the native "Add to Calendar" sheet — this **is** the Apple Calendar integration; no EventKit needed on web.
2. **Google Calendar — template URL** (no API, no OAuth): `https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=20260911T200000/20260911T223000&ctz=America/New_York&details=…&location=…`.

**Implementation shape:** pure functions in `src/lib/calendar/` — `buildIcs(outing, show): string`, `buildGoogleCalendarUrl(outing, show): string`, `resolveEventWindow(date, time, runtime, tz)` — no I/O, no React, `node:test` unit tests (`tests/unit/calendar-*.test.mjs`), written to the `src/lib/stats/` vendoring standard so the iOS app can reuse the Google-URL/ICS builders even though it will prefer `expo-calendar` natively. No npm dependency needed (hand-rolled ICS is ~80 lines; escaping rules are the only subtlety — cover with tests: commas/semicolons/newlines in titles like *Romeo + Juliet*, 75-octet line folding).

### 4.5 iOS app (Phase 2, `BroadwayScorecard-app` repo)

- **Receive invites:** `/join/*` universal link → in-app join screen (same RPCs via the app's Supabase client). Signed-out → native Apple/Google sign-in → resume join (mirror `PendingAction`).
- **Send invites:** RN `Share.share({ url })` from the diary entry — the exact "share sheet" moment the owner described.
- **Calendar:** `expo-calendar` (native EventKit) for one-tap add; fall back to opening the `.ics` URL.
- Vendor `src/lib/calendar/` alongside the existing `stats` vendoring (checksum-drift pattern already established).

---

## 5. Growth & analytics

- **Events (dual-fire `track()` + `captureEvent()`, existing convention):** `outing_time_set`, `outing_invite_created`, `outing_invite_shared` (method: share-sheet/copy/email), `invite_page_viewed` (anon vs authed), `invite_joined`, `signup_via_invite`, `calendar_added` (google/ics, authed/anon), `app_banner_shown/tapped`.
- **Attribution:** invite URLs carry no extra params (token is enough); `signup_via_invite` fires when a `join-outing` pending action completes on a account younger than 5 minutes. PostHog funnel: viewed → joined → signed up → (later) invited someone themselves = the K-factor loop.
- **The loop:** booking tickets is inherently multi-person; every real-world booking seeds 1–3 invite sends into iMessage with a rich OG card. Invitees get immediate anon value (score + calendar), then a 10-second OAuth join. Post-join, the product prompts the *new* user to set up their own diary — each join is a new potential inviter.

## 6. Security & privacy

- Tokens: 21-char nanoid (~126 bits); unguessable is the primary control. Expiry `show_date + 30d`; owner reset regenerates.
- Anon surface is exactly one RPC returning: show fields, date/time, inviter **display name**, member count. Never emails, never user ids, never the member list by name (members see names; anon sees a count).
- No new PII classes: no phone numbers stored (SMS deferred), email invites (Phase 3) go through the existing Resend route conventions with per-IP + per-user rate limits and the `resend-webhook` bounce handling.
- Existing `reviews.visibility` untouched — sharing a plan never shares ratings or review text.
- Migration must pass the Supabase security advisor (no `security_definer_view` regressions; RPCs use `SET search_path = ''`).

## 7. Rollout plan

**Phase 1 — Web MVP (behind `userAccounts && diarySharing`, demo first):**
1. Migration `2026xxxx_outings.sql` (tables, RLS, RPCs, trigger, rate-limit log) — test via CI round-trip like `test-ugc-roundtrip.yml`, not locally (sandbox can't resolve `*.supabase.co`).
2. `src/lib/calendar/` pure lib + unit tests; showtimes fan-out to `public/data/showtimes-index.json`.
3. Showtime picker + outing creation in diary tab; share modal with `navigator.share`/copy.
4. `/join/[token]` page + `join-outing` PendingAction + OG `type=invite`.
5. `/api/calendar/[outingId].ics` + Google URL buttons.
6. Playwright: extend the `?mock=1` mock mode (`tests/e2e/my-shows-mock.spec.ts`) with outing fixtures; visual QA per CLAUDE.md §5.
   - **Exit criteria:** full loop works on demo — create → set time → share → join from a second account → both diaries linked → both calendar paths verified in real Google/Apple Calendar.

**Phase 2 — iOS:** AASA `/join/*` entry (web repo) + app-side join screen, native share, `expo-calendar`, smart app banner + App Store id config (web repo).

**Phase 3 — Growth polish:** email invites (Resend), cancellation/change notifications to members, post-join "invite someone else" prompt, K-factor dashboard. SMS only if share-sheet data shows demand.

**Deliberately out of scope:** friend graph/follows, group chat, multiple performances of one show per user, seat/ticket integration, Android app links (no Android app), editing rights for guests.

## 8. Open questions (owner input, non-blocking — recommendations inline)

1. **Guest edit rights:** v1 recommendation is owner-only edits with trigger-synced dates. OK? (Alternative — any member edits — invites conflict handling complexity.)
2. **App Store id** for the smart banner + universal-link testing: is the iOS app live/TestFlight-only? Phase 2 gate.
3. **`diarySharing` flag to prod:** ship with `userAccounts` whenever that flag ships, or hold for a separate launch beat? (It's a strong launch-week hook: "plan shows with friends.")
