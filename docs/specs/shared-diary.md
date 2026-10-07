# Share my theater diary (BRO-4566)

**Status:** Revised after `/plan-review` (6 reviewers, 2026-10-03). Changes are marked `[CHANGED: reason — source]`. Owner decisions recorded in §0 (2026-10-04). Builds on Shared Plans (BRO-4481, `docs/specs/shared-plans.md`), which is live.

## 0. Owner decisions

1. **The notes box is labelled "Private Notes"** on the website and in the app (`RatingEditor.tsx:244`, app `rate/[showId].tsx:532`). One switch publishes every note at once, including old and imported ones. Proposed: keep the single switch (owner's ask) but (a) turning it on shows "23 of your 112 entries have notes" with a Preview before confirming, and (b) while it is on, the notes box label reads "Notes (shown on your diary link)" on web; iOS gets the same label with Sprint 5. Alternative was a per-note "show on my link" tick. **Decided 2026-10-04: the single switch with these safeguards (owner: "A").** `[CHANGED: pre-mortem P0, user impact, structure]`
2. **Ramp:** ship dates + stars first (switch hidden), owner uses the link for a day, then the notes switch as a small second release. **Adopted** (owner chose A "as the second release after dates and stars"). `[CHANGED: smallest first increment — structure]`

## 1. Brief

**The ask (owner, 2026-10-03):** "You should be able to share your Review list too right?" Decisions, same day: friends see the shows I've seen **with dates and star ratings**; a switch, **off by default**, adds my **written reviews**. It is a **separate link** from the plans link (owner accepted the recommendation: plans go to theater buddies, the diary can go to anyone).

**Who it's for:** the owner (and every signed-in user) wants a one-tap way to show friends "everything I've seen and what I thought", without screenshots and without the friend making an account.

**Why it matters:** the diary is the richest thing a user builds on the site. A shareable, always-current link turns it into something people send around, and every opened link lands a visitor on scored show pages (same growth loop as plans; the sign-up nudge stays V2 for both).

**What it is not:** not a public profile, not indexed, not discoverable. Only people holding the link see it, and the owner can reset or stop it.

| In V1 | Later |
|---|---|
| Web: share sheet on My Shows → Diary, friend page, link preview | iOS share sheet (with plans' Sprint 5, same flag) |
| Shows seen, date seen, star rating | Hide individual entries (V2, same as plans) |
| Written reviews behind an owner switch (off by default) | Photos / Feed |
| Grid and list views, grouped by year, newest first | Stats ("112 shows seen" breakdowns, top-rated) |
| Reset link, stop sharing | Sign-up nudge for viewers (V2) |

## 2. Product spec

### 2.1 Owner: creating and sharing

My Shows → **Diary** tab gets the same **Share** button the Watchlist tab has. It opens the existing share sheet component in a "diary" mode (one component, two kinds; no second design):

> **Share your theater diary**
> Anyone with the link can see the shows you've seen, when, and your star ratings. They don't need an account. You can stop sharing anytime.
>
> [ ] **Include my written reviews** (off by default). Hint: "Your notes are private unless you turn this on."
>
> **Your name on the page** [Tom] — prefilled from the plans share name if one exists, else the profile's first name (same rules and brand guard as plans).
>
> **[Share link]**  Preview · Reset link · Stop sharing

- Turning the written-reviews switch on while live saves immediately (like the plans section toggles). Turning it off removes the text from the friend page on the next load; the sheet says "Previews already sent in chats stay visible there" as plans does.
- Share text: "My theater diary on Broadway Scorecard" + URL.
- Stop sharing → link dead (404 "isn't being shared" page). Sharing again after a stop mints a **new** link (the BRO-4481 ship-check rule).
- The Share button is available whenever the user is signed in (even with an empty diary, so Stop/Reset stay reachable).

### 2.2 Viewer: the diary page

Route **`/seen/[token]`** `[CHANGED: /diary/* would become analytics-dark and leave-by-document forever and reads like /diary-show — design]`. Same shell as `/plans/[token]`: no login, force-dynamic, no-store, noindex/nofollow, no-referrer, links out load a new document, token redacted in every analytics tool.

1. Title "Tom's theater diary"; under it the count with the app's own wording and rule (the iOS Watched tab's "N shows seen"), computed from the rows actually shown; the grid/list switch. `[CHANGED: SQL total vs resolved rows disagreed past the cap; repeat viewings — structure, user impact]`
2. Entries newest first, **grouped by year** with the Diary's year headers ("2026 · 14 entries"); undated entries last under "No date".
3. **Grid** (default): `UpcomingGridCard` (already the iOS card: date pill on the poster, name under it) with gold stars in its `footer` slot, via a shared `Stars` component (My Shows' `MiniStars` moved out). No extraction from `MyShowsClient`. `[CHANGED: extracting DiaryGridCard would ship owner code/types to an anonymous page and collide with BRO-4558 — design, structure, Codex]`
4. **List**: `UpcomingListRow` with stars in `extra` and the note in `note` (its `!plannedDate` guard relaxed so a dated row can carry a note), clamped to 3 lines with "More". `[CHANGED: same — design]`
5. Row/card tap → show page (`/show/<slug>`, or `/diary-show/<slug>` for catalog-only shows; the same `getShowHref` rule).
6. Footer "Make your own list on Broadway Scorecard" (same as plans; real nudge V2).
7. Empty diary: "Tom hasn't logged any shows yet." + "See what's playing".

**Link preview:** "Tom's theater diary" + "112 shows seen" + up to 4 posters of the most recent entries, Inter, same card builder as plans (parameterised title/subtitle).

### 2.3 Privacy rules (product level)

- Shared: show, date seen, star rating; review text **only** with the switch on.
- Never shared: user id, email, avatar, review ids, created/updated timestamps, `visibility`, photos, the To be rated list (unrated past plans), entries dated today or later. Future-dated **reviews** are on neither link (the plans link reads only the watchlist); they are rare (import back-dating) and stay private, as the plans spec already decided. `[CHANGED: the draft wrongly said the plans link covers them — structure]`
- "Seen" = `date_seen` before the show's venue-local today (the plans `venueToday` rule), or undated. One pure `select.ts` applies it for the page, the preview card and the owner sheet's count. `[CHANGED: three different "past" rules — design, structure, Codex]`
- Multiple viewings of one show are separate entries (that is what the diary shows the owner).
- `reviews.visibility` exists but no UI sets or reads it (every row is 'private' by default); V1 ignores it. If a per-review privacy control ever ships, `get_shared_diary` must honour it. Noted in the function.

## 3. Technical plan

### 3.0 Shape

Mirror Shared Plans end to end and share everything that isn't kind-specific. New: one owner-only table, one public function, one page, one view model. Shared: token guard trigger, share sheet, hook, analytics redaction, leave-by-document layout, OG card builder, loader pattern, SQL test harness, round-trip checks.

### 3.1 Data model (one migration `20261004_diary_shares.sql`)

```sql
CREATE TABLE public.diary_shares (
  user_id       UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text,'-','') CHECK (token ~ '^[a-f0-9]{32}$'),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  show_text     BOOLEAN NOT NULL DEFAULT false,
  display_name  TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 30),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
- RLS on, owner-only policies for all four verbs (same as `plan_shares`).
- Guard trigger: the migration creates a generic **`public.share_token_guard()`** (same body as `plan_shares_guard`), repoints the `plan_shares` trigger to it, attaches it to `diary_shares`, drops the old function, and updates both rollback headers. `[CHANGED: sharing a function named for plans made the plans rollback DROP fail or, with CASCADE, silently remove the diary guard — design, pre-mortem, structure, Codex]`
- `rotate_diary_share_token()` (SECURITY INVOKER) mirrors `rotate_plan_share_token()`.
- `show_text` defaults false in the database too, so a client that omits it can never publish text.
- Grants: REVOKE ALL FROM PUBLIC on both functions; `get_shared_diary` to anon+authenticated, rotate to authenticated only.

### 3.2 Public read path `get_shared_diary(p_token)`

Same skeleton as `get_shared_plans` after `20261002_plan_shares_refuse_get.sql`: SECURITY DEFINER, `SET search_path = ''`, refuses a read-only transaction (PostgREST GET → 405) before looking at the token, malformed/unknown/disabled → NULL (indistinguishable).

Returns:
```json
{ "name": "Tom", "showText": false, "total": 112,
  "entries": [ { "show_id": "wicked-2003", "date_seen": "2026-09-20", "rating": 4.5 },
               { "show_id": "hamilton-2015", "date_seen": null, "rating": 5, "text": "…" } ] }
```
- Rows: the owner's `reviews` with `date_seen IS NULL OR date_seen <= current_date + 1` (the +1 day tolerates timezones; the web layer drops anything after the show-local today). Future-dated rows are plans and stay out.
- `text` key present **only when `show_text`**, built in SQL so review text never leaves the database otherwise; empty/whitespace text omitted; truncated in SQL to 4,000 characters. The SQL test asserts the JSON **key** is absent, not just empty. `[CHANGED: unbounded imported text; key-vs-value test — structure]`
- Ordered `date_seen DESC NULLS LAST, created_at DESC`; cap 1000 rows plus `capped: true` when there are more (the page then says "latest 1,000 shown"); no separate SQL total. `[CHANGED: structure, Codex]`
- Never selects `id`, `user_id`, `visibility`, timestamps.

Apply: land → `apply-migration.yml` same sitting (schema verifier derives expectations from migration files). Rollback: revert app code, then a DROP migration.

### 3.3 Web

- Generic pieces move to **`src/lib/share-links/`** (token regex, no-store fetch, `loadShareWith(rpc, isPayload)`, base catalog resolve with a batched stub lookup, `renderShareCard({title, subtitle, posters})`, share-name helpers incl. one `suggestedShareName()`), so plans and diary each import from there and deleting the diary is one directory + one route + one migration + one prefix entry. `[CHANGED: sideways shared-diary→shared-plans imports; N unbatched stub calls per preview fetch — design, structure]`
- `src/lib/shared-diary/`: `select.ts` (pure, `nowMs` injected, parity fixture), `view-model.ts` (group by year), `load.ts`, `og-card.tsx`.
- `src/app/seen/[token]/`: page, not-found, error, opengraph-image, and a layout that re-exports a shared **`PrivateShareLayout`** (robots/referrer metadata + leave-by-document); `/plans/[token]/layout.tsx` re-exports it too. `[CHANGED: instead of renaming PlansLeaveByDocument — design]`
- Analytics: one **`PRIVATE_SHARE_PREFIXES = ['plans', 'seen']`** list in `redact-url.ts` from which the redaction regexes, `isPrivateSharePath` (replay off), the GA inline check (`ga-init-script.ts` stops hand-writing `/plans`) and leave-by-document all derive; a test walks every `src/app/*/[token]` route and asserts its prefix is listed. GA leak check re-run on `/seen/<token>`. `[CHANGED: four hand-coded /plans checks, any one missed leaks the token — design, structure]`
- Owner side: no `kind` union. A config-driven **`useShareRow({ table, rotateRpc, columns, urlFor })`** holds the ensure / rotate-after-stop / rollback logic now in `usePlanShare`; a shared **`ShareLinkPanel`** (name field, Share/Preview/Reset/Stop, "Sharing is on"). `SharePlansModal` stays (thin, its section toggles) and a new thin `ShareDiaryModal` adds the notes switch with the count + Preview confirm. `[CHANGED: kind branches in every function — design; Codex blast radius]`
- My Shows: the Diary tab gets a Share button (a few lines in `MyShowsClient`; nothing else there changes).

### 3.4 Testing

- SQL harness (`scripts/test-plan-shares-sql.sh`, generalised): token minting, guard, rotate, RLS, grants, GET refusal, future rows excluded, `text` absent when `show_text = false` (the key test), cap + total, ordering.
- Unit: view model grouping/ordering/undated, resolution, redaction for `/seen/`, share URL, leave-by-document for `/seen/`.
- Live round-trip (`test-ugc-roundtrip.mjs`): create share, read via POST, GET refused, text hidden then shown when toggled, stop → NULL.
- Visual QA on a `/test/seen-fixture` (real catalog shows, made-up entries) at 360–1440, owner approval.
- **Plans regression:** plans round-trip, plans fixture screenshots and the share-sheet browser check re-run after the hook/panel refactor. `[CHANGED: refactor of a feature shipped today — structure]`
- Manual before real users: send the link in iMessage and WhatsApp with notes on (no note text in the preview); turn notes off and use Safari back/forward (text gone after reload); robots.txt does not block `/seen/` (so noindex is seen); preview image headers. `[CHANGED: user impact]`
- Prod smoke after land: unknown token → 404 page with noindex/no-referrer; owner trial from their own diary.

### 3.5 Rollout `[CHANGED: only the My Shows Share button waits on BRO-4558; notes switch is a second release — structure, design]`

1. Sprint A: migration (`diary_shares`, `share_token_guard`, `get_shared_diary`, rotate) + SQL tests + live round-trip; apply. Independent of BRO-4558.
2. Sprint B: `share-links/` extraction, `select.ts`, page on `UpcomingGridCard`/`UpcomingListRow` + `Stars`, OG card, prefix registry. Plans regression checks.
3. Sprint C: `useShareRow` + `ShareLinkPanel`, `ShareDiaryModal` (dates + stars only, notes switch hidden), Diary Share button (after BRO-4558 lands, to avoid conflicts in `MyShowsClient`). Land, prod smoke, owner uses it for a day.
4. Sprint D (small): notes switch with count + Preview confirm and the "shown on your diary link" label. Land, owner trial with notes.
5. iOS joins plans' Sprint 5.

## 4. Risks

- **Review text is personal, and the UI calls it "Private Notes".** Mitigation: off by default in DB and UI, filtered and truncated in SQL, key-absence SQL test, count + Preview confirm before it goes on, editor label changes while on, separate release (Sprint D). Turning it off: sheet copy says open tabs keep the text until reload and chat previews/screenshots stay.
- **Big diaries** (1,000+ entries): cap + total, server-rendered list; grid uses lazy-loaded posters.
- **Extraction churn on My Shows** (third session in a week touching it): sequence after BRO-4558; extraction "moved unchanged" with My Shows screenshots before/after.
- **Old shows not in the catalog** (diary-only imports): resolved through the same catalog/stub rule as plans (batched); unresolvable rows are dropped and the count is computed after resolution.
- **Preview caching:** the preview image is cached up to 10 minutes at the CDN and indefinitely in chat threads; the sheet says so (as plans does).

## 5. Plan review record (2026-10-03)

Reviewers: gpt-5.4-mini (production/architecture; Codex CLI not in cloud), Claude structure + devil's advocate, Claude pre-mortem, Gemini 2.5 Flash (consistency), Claude user impact, Claude code design (read the shipped plans code). Top findings: the "Private Notes" label (pre-mortem, user impact, structure); reusing `plan_shares_guard` makes the plans rollback unsafe (4 reviewers); a `kind` union across the share sheet/hook (design, Codex); extracting owner diary cards for an anonymous page while BRO-4558 restyles them (design, structure, Codex); four hand-coded `/plans` analytics checks (design, structure); three different "past" rules (design, structure); count vs cap mismatch (structure, Codex, user impact); future-dated reviews wrongly said to be on the plans link (structure). Dismissed: "GET refusal blocks link previews" (the RPC is called server-side by the page; crawlers fetch the page, not the RPC).
