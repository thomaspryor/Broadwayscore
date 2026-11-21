# Spec: Diary Show Sharing (Outings) + Add to Calendar

**Status:** Proposed — not yet implemented. Revised after `/right-problem` (§0) and `/plan-review` (6 reviewers; changes annotated `[CHANGED: …]`).
**Author:** Claude (session 2026-08-05), from owner request
**Scope:** Web (Next.js/Vercel) first, iOS (Expo) second
**Feature flags:** calendar under existing `userAccounts`; invites under new `diarySharing` (see §7)

---

## 0. Validation verdict (/right-problem, 2026-08-05)

Two independent reviewers (GPT challenger + Claude judge) evaluated this spec's direction. Convergent findings, baked into the phasing in §7:

1. **Calendar-first, sharing second.** The only confirmed users today are the owner + partner; the calendar/showtime feature serves them every booking and has zero dependency on sharing. It ships first, standalone (Phase 0).
2. **A viral loop can't land on a disabled feature.** `userAccounts` is off in production (demo-only). Invite pages whose CTA is "create an account" are a dead end until accounts ship to prod — so the invite flow (Phase 1) is *sequenced after* the accounts prod launch, and every invite page must deliver value without an account (score + Add to Calendar work anonymously).
3. **The .ics is itself a sharing mechanism.** A calendar event is already a shareable, multi-person, reschedule-propagating object. Embedding the show URL in the event description gives "Joanna gets the plan + a link back" with zero backend — shipped in Phase 0. (Phase 0 is standalone in *implementation*; this is a free side-door, not a dependency.)
4. **Start invites stateless.** A `/join` page that renders entirely from URL params delivers ~90% of the invite experience with no tables, tokens, RLS, or sync. The full shared-membership "outing" object (§3.1) is the *upgrade path*, built only on evidence (§7 Phase 2 trigger). Reviewer verbatim: "the shared outing object is probably overengineering with a growth costume on it." §1's companions display is the Phase 2 end-state, not the Phase 1 deliverable.
5. **Kept from the challenger:** a shareable "theater night card" OG image (people forward images more readily than they join systems) — the Phase 1 link preview is a hard prerequisite for the invite flow's effectiveness, not polish.

A subsequent `/plan-review` (GPT production, Claude structure + pre-mortem + user-impact + codebase-grounded design, Gemini consistency) drove these major revisions: signed invite params (§4.3), ICS UID/DST fixes (§4.4), `PerformanceEvent` shape + shared param codec (§4.4), universal-link claim moved to the iOS phase (§7), single `curtain_time` name (§3.0), and reuse of existing picker/schedule components (§4.2).

---

## 1. What we're building

Two user-facing features that ultimately share one data model:

1. **Invite friends to a diary entry.** "I have Broad Strokes on my diary for Sep 11 — add Joanna." The owner shares a link (iOS share sheet / copy link / email); Joanna opens it, sees a rich invite page, signs in (or creates an account gracefully), and the show lands in *her* diary too — with companions shown once Phase 2 lands. This doubles as a viral growth loop: every invite link is an acquisition page with the show's score, an account-creation prompt, and an app-download nudge.

2. **Add to Calendar (Google + Apple).** From a diary entry, add the performance to your calendar with the real curtain time. Because diary entries today only store a *date*, this introduces a **showtime picker** (matinee vs. evening, e.g. 2:00 PM / 8:00 PM, with manual override for unusual times like 5:30).

---

## 2. Current-state constraints (from codebase audit)

| Fact | Consequence |
|---|---|
| An "upcoming diary entry" = a `watchlist` row (`planned_date DATE`, `UNIQUE(user_id, show_id)`); reviews are `reviews` rows (`date_seen DATE`). No time-of-day column anywhere (`supabase-schema.sql:16-36`) | Time must live somewhere new; the unique constraint means a user can't have two planned dates for one show |
| `reviews`/`watchlist` RLS is strictly owner-only (`supabase-schema.sql:93-125`) | Sharing needs a new object + policies, not a loosening of existing ones |
| Proven share pattern exists: Lists — `share_slug` (random), anon read policy, `/list/[slug]` page with OG image (`useUserLists.ts:284-318`, `src/app/list/[slug]/page.tsx`) | Reuse the shape; but diary invites use an RPC-scoped read, not a blanket anon SELECT (PII lesson from `20260422b` — §5.3) |
| Post-sign-in resume hook exists: `deferred-auth.ts` + `PendingAction` (`src/types/user.ts:76-87`) — note it's an optional-fields bag today, not a discriminated union | "Accept invite → sign in → auto-join" extends an existing mechanism; convert `PendingAction` to a discriminated union while adding the variant (cheap at 4 variants) `[CHANGED: match real type shape — design review]` |
| Auth = Supabase, **Google + Apple OAuth only**; no email magic link, no phone auth | "Add by phone number" as an *auth* method is out of scope v1; phone-based invites go through the share sheet (iMessage) instead |
| Email infra exists (Resend, `noreply@broadwayscorecard.com`); **no SMS provider** | Email invites are cheap to add (Phase 3); SMS deferred — share sheet → Messages covers the same need free |
| Showtime data exists: `data/show-schedules.json` (42 Broadway shows, weekly matinee/evening grid with clock times) + `data/todaytix-showtimes.json` (142 BW/OB/WE shows, per-date m/e slot existence, no clock times) | The picker can be smart for covered shows, with a manual fallback for everything else |
| `ShowtimesCard.tsx:25-71` already implements `formatTime`, `parseMonday`, `getMondayPlusDayDate` privately; `DatePickerButton.tsx:50-95` carries hard-won iOS-wheel logic | Extract and reuse, don't duplicate (§4.2) `[CHANGED: design review]` |
| Site is a hybrid Next.js app on Vercel with 23 live API routes (incl. edge OG image) — *not* a static export | Server-generated `.ics` and invite metadata pages are straightforward |
| Universal Links claim only `/show/*` and `/auth/callback` | `/join` claim ships **with the app's join handler** (iOS phase), never before — else installed-app users tap into a handler-less app `[CHANGED: was Phase 1 — structure review]` |
| iOS app is Expo/RN; pure shared logic is vendored from `src/lib/stats/` per-directory with checksum drift detection | Calendar logic = self-contained pure module taking pre-parsed inputs (no cross-directory imports) (§4.4) |
| Everything user-account-related is gated by `featureFlags.userAccounts` (demo-only in prod) | Calendar gates on `userAccounts` alone; `diarySharing` additionally gates invites — so a future "hold sharing for a launch beat" decision can't hold the calendar hostage `[CHANGED: flag split — structure review]` |

---

## 3. Data model

### 3.0 Phase 0 — time-of-day without any new object

Calendar export only needs a time on the user's own entry. Add two nullable columns to `watchlist` (owner-only RLS unchanged, existing diary queries unaffected):

```sql
ALTER TABLE watchlist ADD COLUMN time_slot TEXT CHECK (time_slot IN ('matinee','evening','custom'));
ALTER TABLE watchlist ADD COLUMN curtain_time TIME;  -- local wall-clock; same name Phase 2 uses on outings
ALTER TABLE watchlist ADD CONSTRAINT curtain_time_requires_slot
  CHECK (curtain_time IS NULL OR time_slot IS NOT NULL);  -- no orphan times
```

`[CHANGED: one name (`curtain_time`) across watchlist/outings/types/events + cross-column CHECK — design review]`

A real column, not client-side state: the iOS app vendors the diary data logic, so time must live in the one shared store. **Rollback:** both columns are additive + nullable — `DROP COLUMN` is safe at any point; no backfill exists to lose. `[CHANGED: rollback stated — GPT/Gemini]`

### 3.1 Phase 2 (conditional) — shared-outing tables

```sql
CREATE TABLE outings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id       TEXT NOT NULL,               -- shows.json id OR diary-catalog id (same convention as watchlist.show_id)
  show_date     DATE NOT NULL,
  time_slot     TEXT CHECK (time_slot IN ('matinee','evening','custom')),
  curtain_time  TIME,
  tz            TEXT,                        -- IANA, from the market→tz map in src/lib/calendar/ (single source, §4.4)
  created_by    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invite_token  TEXT UNIQUE NOT NULL,        -- 21-char nanoid, minted at creation
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

ALTER TABLE watchlist ADD COLUMN outing_id UUID REFERENCES outings(id) ON DELETE SET NULL;
```

**Why a separate object instead of columns on `watchlist`:** `watchlist` is owner-only under RLS and consumed by existing diary/stats code on web *and* iOS. The outing is the natural unit for group semantics; copy-on-join means each member keeps their own `watchlist` row (diary survives outing deletion; reviews stay per-person and private).

**Sync semantics: owner-editable, propagated.** Only the owner edits `show_date`/`curtain_time`/`time_slot`. A trigger on `outings` UPDATE syncs every member's linked `watchlist` row — **all three of `planned_date`, `time_slot`, `curtain_time`** — via a **SECURITY DEFINER trigger function** (it writes other users' owner-only-RLS rows; a plain trigger would fail RLS). `[CHANGED: time columns + DEFINER explicitly — structure review]` Guests can leave (membership deleted; their watchlist row keeps its values, drops `outing_id`).

### 3.2 RLS + access functions (Phase 2)

Members read their outings via a normal policy; **anonymous invite preview goes through a SECURITY DEFINER RPC, not an anon SELECT policy** (per the `20260422b` PII incident pattern):

```sql
CREATE POLICY "members read outings" ON outings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM outing_members m WHERE m.outing_id = id AND m.user_id = auth.uid()));
-- Owner-only UPDATE/DELETE; INSERT with created_by = auth.uid().
-- outing_members: members read; owner or self delete; inserts ONLY via join_outing().

CREATE FUNCTION get_outing_invite(p_token TEXT)
RETURNS TABLE (show_id TEXT, show_date DATE, time_slot TEXT, curtain_time TIME, tz TEXT,
               inviter_name TEXT,            -- profiles.display_name only, never email
               member_count INT, status TEXT)
SECURITY DEFINER SET search_path = '' ...;
-- Returns zero rows identically for unknown, expired, and cancelled tokens — no existence oracle.

CREATE FUNCTION join_outing(p_token TEXT) RETURNS UUID SECURITY DEFINER ...;
```

`[CHANGED: uniform empty result for all invalid-token cases — GPT]`

Rate limiting: outing creation capped (e.g. 30/day/user, `mezzanine_search_log` convention). The `/join/[token]` page is a server component with no API layer in front — its per-IP throttle lives in the page's server code (small in-memory/KV counter, same shape as `send-picks`'s IP limiter), while the real defense stays 128-bit token entropy. `[CHANGED: named where the limiter actually lives — structure review]`

### 3.3 Join semantics (Phase 1 stateless AND Phase 2 — same rules)

`[CHANGED: rules now cover Phase 1's PendingAction path, which hits the same constraint — structure review]`

- **Invitee already has the show on their watchlist** (`UNIQUE(user_id, show_id)`): upsert — set `planned_date`, `time_slot`, `curtain_time` (all three) to the invite's values and, in Phase 2, link `outing_id`. **The UI confirms before overwriting a differing existing date** ("You had this planned for Oct 3 — switch to Sep 11 with Tom?"). `[CHANGED: confirm-before-clobber — GPT/user-impact]`
- **Invitee already reviewed the show:** still joins; the show appears in Upcoming for the new date. (Seeing a show twice remains unrepresentable in `watchlist`; accepted v1 limit.)
- **Owner deletes the entry / outing (Phase 2):** outing → `status='cancelled'`; members' watchlist rows persist (`ON DELETE SET NULL`). No notification in v1.
- **Duplicate join:** idempotent (PK / upsert).
- **Token lifetime (Phase 2):** valid while `active` and until `show_date + 30 days`; owner "Reset invite link" (in the share modal) regenerates. Phase 1 signed links (§4.3) stop *rendering as invites* once `show_date` passes — the page switches to "This performance has passed" + show link.

---

## 4. UX flows

### 4.1 Diary entry actions (web, diary tab)

Entry cards in **Upcoming** gain two actions (icon row, mobile-first):

- **🕐 Set time** → showtime picker (§4.2). Phase 0: writes `time_slot` + `curtain_time` on the user's watchlist row. Phase 2: creates/updates the outing, trigger-synced back to those columns.
- **👥 Invite** (Phase 1) → share modal: primary **"Share invite link"** via `navigator.share({ title, text, url })` (share sheet: iMessage, WhatsApp, Mail…); desktop fallback copy-to-clipboard (`ListsTab.tsx:185` pattern). Phase 1 links are signed params URLs (§4.3); Phase 2 upgrades to outing tokens. "Add by phone number" is deliberately not a form field — the share sheet → Messages *is* that feature, and the modal copy says so.
- Companions display ("With Joanna", avatar stack) arrives with Phase 2. Per the Beli/Untappd pattern (§8): companion tagging should live *inside* the log/rating editor too, not only as a standalone share action — and Phase 2's `outing_members` supports a **name-only placeholder** ("ghost tag": `display_name` set, `user_id` NULL) that a later invite-join claims, so tagging a friend who isn't on the product yet is itself the invite.

Same actions on the show page's diary widget and `/diary-show/[id]` for catalog shows.

### 4.2 Showtime picker

Given `show_id` + `planned_date`, resolve in order:

1. **`show-schedules.json` weekly grid** (42 BW shows): exact chips — "2:00 PM Matinee" / "8:00 PM Evening" for that weekday.
2. **`todaytix-showtimes.json` per-date slots** (142 shows): slot existence for the specific date; clock time from the grid if available, else market-default label ("Evening (~7:30 PM)").
3. **Fallback (everything else, incl. 32k catalog shows):** manual — quick chips `2:00 · 3:00 · 5:30 · 7:00 · 7:30 · 8:00` + native time input (`time_slot='custom'`).

Always show **"Other time…"** even when the grid matches. Schedule data is *advisory*: it prefills chips but never blocks manual entry, so staleness degrades gracefully. `[CHANGED: advisory framing — structure review]`

**Component reuse (mandatory):** `[CHANGED: design review P1s]`
- Extract `formatTime`, `parseMonday`, `getMondayPlusDayDate` from `ShowtimesCard.tsx` into the shared pure lib; ShowtimesCard consumes the extracted versions (CLAUDE.md §15 extract→export→wire-back). Do not re-implement.
- The time input **generalizes `DatePickerButton`** (`inputType: 'date' | 'time'` on one shared core) rather than copying its hidden-native-input pattern — that component encodes three owner-reported iOS wheel bugs a sibling copy would re-fight.

**Data plumbing:** prebuild fan-out (extend `scripts/generate-diary-data.js` or sibling) emits one compact `public/data/showtimes-index.json`, fetched lazily when the picker opens. **Staleness reality:** the index refreshes only on deploy; `todaytix-showtimes.json` updates on a CI cron. Verify `scripts/lib/should-deploy-gate.js` counts the index among site-relevant paths; regardless, tier-3 fallback + the 10-day staleness heuristic (`ShowtimesCard.tsx:106`) bound the damage. `[CHANGED: deploy-gate interaction flagged — structure review]`

### 4.3 Invite landing page — `/join` (Phase 1) / `/join/[token]` (Phase 2)

Phase 1 renders from URL params — **signed**: `/join?s=showId&d=YYYY-MM-DD&t=1930&from=Tom&sig=<hmac>`.

**Abuse hardening (Phase 1 ships with ALL of these — the pre-mortem's primary incident is this page weaponized as a phishing-card generator):** `[CHANGED: pre-mortem P0]`
- `sig` = HMAC-SHA256 (server secret) over the canonical params. Links are mintable **only** by our share modal (a tiny authed API route signs them). Invalid/absent sig → generic show page redirect, no invite framing, no OG invite card. Stateless *and* forgery-proof (~20 lines).
- `from` display name: ≤30 chars, letters/spaces/hyphens only, stripped of URLs and brand-impersonation keywords at *mint* time (it's inside the HMAC, so it can't be altered after). Render fallback: "A friend invited you."
- `/api/og?type=invite`: only rendered for valid-sig requests; per-IP rate limit + long `Cache-Control` (same image for same link).
- Past `d` → "This performance has passed" state (no invite CTA). Unknown `s` → 404. Catalog shows (no poster/score) → text-hero variant, generic OG card — specified, not accidental. `[CHANGED: past-date/catalog states specified — structure/user-impact]`
- `robots: noindex`; analytics `invite_page_viewed` fires on human interaction (first scroll/tap), not page load — link-preview crawlers (iMessage fetches every share) would otherwise inflate the funnel and could trip the Phase 2 evidence trigger on bot traffic. `[CHANGED: bot filtering — structure review "dumbest failure"]`

**Page content (anon):** show hero (poster, ScoreBadge, venue — design-system components), "Tom invited you", date + time, and:
- **Primary CTA "Join this outing"** → `SignInModal` with invite context copy; `PendingAction` discriminated-union variant `{ type: 'join-outing', payload }`; after OAuth, apply §3.3 join semantics → `/my-shows` with success toast.
- **Secondary CTA "Add to calendar"** — no account needed (§4.4); the event carries the join link for later conversion.
- Tertiary: show page link ("See reviews · 87 Critic Score").
- **Signed-in visitor:** one-tap Join. Already joined → "You're going! View in your diary."
- **App download:** post-join success card "Get the iOS app" (dismissible, suppressed in-app). Smart banner + AASA claim wait for the iOS phase (§7).

Phase 2 swaps params for `get_outing_invite(token)` — same page shell, same states.

### 4.4 Add to Calendar

Placement: entry card + entry editor + join page + post-join screen. No time set yet → picker opens first.

**Implementation shape `[CHANGED: design review P1 — minimal-shape API, shared codec]`:** one pure module `src/lib/calendar/` (no I/O, no React, `node:test`, vendorable standalone — **no imports from `stats/`**; duration arrives pre-parsed):

```ts
interface PerformanceEvent {  // the one event shape; DB rows, outings, and URLs all map into it
  title: string; date: string;            // YYYY-MM-DD
  time: string | null;                    // HH:MM, null = all-day fallback
  tz: string | null;                      // IANA from the market→tz map (lives here, single source)
  durationMin: number;                    // caller pre-parses runtime (default 150 + 15 buffer)
  location: string; showUrl: string; joinUrl?: string; companions?: string[];
}
buildIcs(ev: PerformanceEvent): string
buildGoogleCalendarUrl(ev: PerformanceEvent): string
encodeEventParams(ev)/decodeEventParams(qs)  // shared codec — /join, /api/calendar.ics, share modal all use it; Phase 2 token swap touches one file
```

Buttons (ordered by platform: iOS/macOS → Apple first; Android → Google first `[CHANGED: user-impact]`):

1. **Apple / Outlook — `.ics`.** Served by `GET /api/calendar.ics?<signed params>` from **Phase 0** (route calls the pure lib; client-side Blob download of `.ics` is historically flaky on iOS Safari — a served `text/calendar` response reliably opens the native add sheet). `[CHANGED: route in Phase 0, not Blob — user-impact/pre-mortem]`
   - `DTSTART;TZID=…` with `VTIMEZONE` blocks **copied byte-for-byte from tzdata reference ICS** for `America/New_York` and `Europe/London` — never hand-written RRULEs. Unknown market → floating local time.
   - **DST is a named test fixture:** unit tests assert resolved UTC instants for dates straddling both transitions (Mar/Nov US, Mar/Oct UK), and Phase 0 exit criteria include a *Google Calendar* import check — Google parses VTIMEZONE strictly where Apple silently substitutes its own tz db, so Apple-only testing masks DST bugs. `[CHANGED: pre-mortem secondary]`
   - `UID: bsc-{showId}@broadwayscorecard.com` — **date excluded**, so a reschedule + re-export *updates* the event; `SEQUENCE` = generation unix-timestamp (monotonic without stored state). Phase 2 keeps the same UID for continuity. `[CHANGED: UID embedded the date → duplicates on reschedule; SEQUENCE had no state to bump from — structure review]`
   - `SUMMARY: 🎭 {title}`, `LOCATION` from `theaterAddress` (741 shows) falling back to venue + city, `DESCRIPTION` with companions, show URL, join URL. Escaping + 75-octet folding covered by tests (*& Juliet*, *Romeo + Juliet*); `resolveEventWindow` handles past-midnight end times (11 PM curtain + 2h30).
2. **Google Calendar — template URL** (no API): `calendar.google.com/render?action=TEMPLATE&dates=…&ctz=…`. Caveat surfaced in UI copy: requires a Google session; each open creates a *new* event (no UID semantics) — the UI labels it "opens Google Calendar" and leans Apple-first on iOS.

### 4.5 iOS app (later phase, `BroadwayScorecard-app` repo)

- `/join` universal link → in-app join screen (same join semantics via the app's Supabase client; mirror PendingAction). **AASA `/join*` claim ships in the same release as this handler** — never earlier. Note the Phase 1 URL is query-based (`/join?...`), so the AASA component entry must match `/join` with query, not just `/join/*`.
- Send invites: RN `Share.share({ url })` from the diary entry.
- Calendar: `expo-calendar` (native EventKit); fall back to opening the `.ics` route URL.
- Vendor `src/lib/calendar/` alongside `stats/` (it's self-contained by design, §4.4).

---

## 5. Growth & analytics

- **Events (dual-fire `track()` + `captureEvent()`), trimmed to what gates decisions** `[CHANGED: was 10+, GPT]`: Phase 0 — `outing_time_set`, `calendar_added` (method, authed/anon). Phase 1 adds — `invite_shared` (method), `invite_page_viewed` (human-interaction-gated, §4.3), `invite_joined`, `signup_via_invite`. Everything else waits for Phase 2 evidence needs.
- **Attribution:** `signup_via_invite` = `join-outing` PendingAction completing on an account <5 min old. Funnel: shared → viewed → joined → signed up → later invited someone = the K-factor loop. **This funnel is the Phase 2 evidence source — measure it, don't assume it.**

## 6. Security & privacy

- Phase 1: HMAC-signed params (§4.3) — no tokens to store, nothing forgeable, no PII in links (first name only, sanitized at mint, sig-protected).
- Phase 2: 21-char nanoid tokens (~126 bits); expiry `show_date + 30d`; owner reset. Anon surface = one RPC returning show fields, date/time, inviter display name, member *count* (never the member list, never emails/user ids); identical empty result for unknown/expired/cancelled tokens.
- No new PII classes: no phone numbers stored; email invites (Phase 3) ride existing Resend conventions + `resend-webhook` bounce handling.
- `reviews.visibility` untouched — sharing a plan never shares ratings or review text.
- Migrations must pass the Supabase security advisor; RPCs and the sync trigger function use `SET search_path = ''`.
- OG invite renderer: sig-gated + rate-limited + cached (§4.3) — it must never be a free branded-image API.

## 7. Rollout plan (revised per §0 + plan-review)

**Phase 0 — Calendar + showtime, standalone (~1-2 sessions; behind `userAccounts` only — demo now, prod when accounts ship):**
1. Migration: `watchlist.time_slot` + `curtain_time` (§3.0; additive/nullable, rollback = drop). Verify via CI round-trip (local sandbox can't reach Supabase; `test-ugc-roundtrip.yml` pattern).
2. `src/lib/calendar/` pure module (`PerformanceEvent`, builders, codec, market→tz map, tzdata VTIMEZONE fixtures) + DST/escaping/midnight-rollover unit tests. Extract ShowtimesCard time helpers into it (wire ShowtimesCard back).
3. Showtime picker (generalized `DatePickerButton` core) + showtimes-index fan-out.
4. Add-to-Calendar buttons + `GET /api/calendar.ics` route; "Get directions" row (Maps URL from `theaterAddress`, §8).
5. Countdown timer on upcoming entry cards (client-side, §8).
6. Playwright `?mock=1` fixtures + visual QA (CLAUDE.md §5).
   - **Exit criteria (owner-verified on device, stated because it isn't CI-verifiable):** an 8:00 PM entry lands correctly in **Apple Calendar (iPhone)** AND **Google Calendar** (strict VTIMEZONE parser) including one date on the far side of a DST transition; duration/venue correct. `[CHANGED: who verifies + Google + DST made explicit — structure/pre-mortem]`

**Phase 1 — Stateless signed invites (~1-2 sessions; precondition: `userAccounts` live in prod; flag: `diarySharing`):**
1. Sign+mint API route; `/join` page with all §4.3 hardening (sig check, sanitized `from`, past-date/catalog states, bot-gated analytics).
2. "Add to my diary" via `PendingAction` union variant, applying §3.3 join semantics (upsert incl. time columns, confirm-before-overwrite).
3. Share modal (`navigator.share`/copy) + OG `type=invite` card (sig-gated, rate-limited, cached).
4. Analytics per §5.
   - **Exit criteria:** full loop on prod — share → rich card in iMessage → invitee adds to calendar anonymously OR one-tap-signs-up and the entry (with time) lands in their diary; a tampered link renders no invite framing.
   - **Accepted gaps:** no companions display; links are snapshots (reschedule doesn't propagate — the .ics UID mitigates for calendar users); no revocation (mitigated by sig + past-date cutoff).

**Phase 2 — Shared outings (§3.1-3.3), CONDITIONAL:** build on evidence from the §5 funnel — e.g. sustained human joins (~20/month) or explicit "who else is coming?"/reschedule-propagation asks. Adds: tables, token links (same page shell), companions UI, owner-reschedule propagation via SECURITY DEFINER trigger, revocation. Phase 0/1 upgrade in place; params links keep working until expiry.

**Phase 3 — iOS + growth polish:** app join screen + AASA claim (together, §4.5), native share, `expo-calendar`; email invites (Resend); post-join "invite someone else"; K-factor dashboard. SMS only if share-sheet data shows demand.

**Deliberately out of scope:** friend graph/follows, group chat, multiple performances of one show per user, seat/ticket integration, Android app links, guest edit rights.

## 8. Design inspiration (owner-supplied + research, 2026-08-05)

Owner shared TodayTix's post-purchase order screen as the reference vibe: show card (poster / date+time / venue), "Share your tickets securely" with an avatar stack + "＋ Invite" circle, "Add to calendar" row, share-sheet handoff. Two cheap patterns from those screens adopted into scope:
- **Countdown timer** on upcoming diary entries ("37 days : 0 hrs : 52 min") — pure client-side, high delight; add to the Phase 0 entry card.
- **"Get directions" row** next to Add to Calendar — `theaterAddress` exists for 741 shows; Apple/Google Maps URL, zero backend. Phase 0.

Reference apps — **the owner's framing (2026-08-05): the right comparison set is social *trackers* where a diary entry carries companions, not event-invite apps** (Partiful/Apple Invites explicitly ruled out):
- **Beli** (restaurant tracker) — closest 1:1 analog: personal diary + rankings where you **tag the friends you ate with** at log time; the visit connects on their side; tagging + leaderboards ARE the growth engine. Proof the mechanic drives viral growth in a niche vertical.
- **Strava** — the data-model reference: same run auto-groups into one shared event, but each person keeps their own record/stats/notes. Validates §3's copy-on-join (shared outing, separate diary entries, ratings stay individual).
- **Untappd / Swarm** — the check-in gesture: companion tagging lives *inside the log flow* (same screen as the rating, not a separate share step), and you can tag someone **not yet on the app** — the "ghost tag → invite" pattern: tag Joanna by name now, she gets the link, the tag resolves to her account when she joins. Adopt for §4.1: the Invite action should also be reachable from the rating/log editor, and Phase 2 membership should support a name-only placeholder that an invite later claims.
- **StoryGraph buddy reads / Fable book clubs** — a shared "we're doing this together" object inside a personal tracker; shared progress, individual reviews. Analog for the *upcoming* shared state.
- **Letterboxd** (the diary's north star) — has **no "watched with" feature**, one of its most-requested. TodayTix owns the upcoming half, Beli the past half; spanning both for theater is the differentiator.
- Secondary UX references (mechanics only): Fandango/AMC (date strip + time chips for §4.2), Resy/OpenTable (guests on a reservation, day-of reminders), Ticketmaster (transfer-flow friction as the cautionary tale our one-tap join should beat).

## 9. Open questions (owner input, non-blocking — recommendations inline)

1. **Guest edit rights (Phase 2):** recommend owner-only edits with trigger-synced dates.
2. **App Store id** for the smart banner + universal-link testing: needed at the iOS phase. Is the app live/TestFlight-only?
3. **Flag sequencing:** calendar rides `userAccounts` to prod automatically (recommended); `diarySharing` can launch same-day or as its own beat ("plan shows with friends") — owner's call.
