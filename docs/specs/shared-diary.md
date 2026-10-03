# Share my theater diary (BRO-4566)

**Status:** Draft for `/plan-review` (2026-10-03). Builds on Shared Plans (BRO-4481, `docs/specs/shared-plans.md`), which is live.

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

Route **`/diary/[token]`** (no clash: the site has `/diary-show/<slug>`, not `/diary`). Same shell as `/plans/[token]`: no login, force-dynamic, no-store, noindex/nofollow, no-referrer, links out load a new document, token redacted in every analytics tool.

1. Title "Tom's theater diary"; under it "112 shows seen" (count of shared entries); the grid/list switch.
2. Entries newest first, **grouped by year** with the Diary's year headers ("2026 · 14 entries"); undated entries last under "No date".
3. **Grid** (default): the Diary's past-show poster card (after BRO-4558: iOS design, date pill on the poster, gold stars, show name under it). No remove/edit controls.
4. **List**: the Diary's list row (date block, poster, title, venue, stars right). When written reviews are on, the review text shows under the row, clamped to 3 lines with "More" to expand (no navigation).
5. Row/card tap → show page (`/show/<slug>`, or `/diary-show/<slug>` for catalog-only shows; the same `getShowHref` rule).
6. Footer "Make your own list on Broadway Scorecard" (same as plans; real nudge V2).
7. Empty diary: "Tom hasn't logged any shows yet." + "See what's playing".

**Link preview:** "Tom's theater diary" + "112 shows seen" + up to 4 posters of the most recent entries, Inter, same card builder as plans (parameterised title/subtitle).

### 2.3 Privacy rules (product level)

- Shared: show, date seen, star rating; review text **only** with the switch on.
- Never shared: user id, email, avatar, review ids, created/updated timestamps, `visibility`, photos, the To be rated list (unrated past plans), future-dated entries (those are plans; the plans link covers them).
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
- Guard trigger: **reuse `public.plan_shares_guard()`** (it only touches `token`, `user_id`, `display_name`, `updated_at` and the `bsc.rotate_token` flag, all present here). One audited guard, not two. If review shows it is table-specific in any way, copy it as `share_token_guard()` and point both tables at it.
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
- `text` key present **only when `show_text`**, built in SQL so review text never leaves the database otherwise; empty/whitespace text omitted.
- Ordered `date_seen DESC NULLS LAST, created_at DESC`; cap 1000 rows; `total` = full count (so "1,240 shows seen" stays true if capped; the page notes "showing the latest 1,000").
- Never selects `id`, `user_id`, `visibility`, timestamps.

Apply: land → `apply-migration.yml` same sitting (schema verifier derives expectations from migration files). Rollback: revert app code, then a DROP migration.

### 3.3 Web

- `src/lib/shared-diary/` mirrors `src/lib/shared-plans/`: `load.ts` (uncached POST RPC, 404/503 split), `resolve.ts` (reuse `resolvePlanShowsFromCatalog`-style resolution; generalise it to `resolveShowsFromCatalog` rather than copy), `view-model.ts` (group by year, counts, title/summary strings), `og-card.tsx` (thin wrapper over a shared `renderShareCard({title, subtitle, posters})` extracted from the plans card).
- `src/app/diary/[token]/` page, layout (metadata + `PlansLeaveByDocument`, renamed `ShareLeaveByDocument`), not-found, error, opengraph-image.
- Cards: extract the Diary's past-show grid card and list row from `MyShowsClient` into `src/components/user/diary-cards.tsx` (after BRO-4558 lands, so its iOS styling is what gets extracted), the same move BRO-4481 made for `upcoming-cards.tsx`. Owner-only controls (delete, edit, rate) become optional props.
- Analytics: generalise `isSharedPlansPath` / the redaction pattern to cover `/diary/<token>`, GA init and leave-by-document included. Tests: the existing redaction tests get `/diary/` cases; the GA leak check script is re-run on `/diary/<token>`.
- Owner side: `SharePlansModal` → `ShareSheet` with `kind: 'plans' | 'diary'`; `usePlanShare` → `useShare(kind)` (table + rotate RPC chosen by kind). Diary mode swaps the section toggles for the written-reviews switch.

### 3.4 Testing

- SQL harness (`scripts/test-plan-shares-sql.sh`, generalised): token minting, guard, rotate, RLS, grants, GET refusal, future rows excluded, `text` absent when `show_text = false` (the key test), cap + total, ordering.
- Unit: view model grouping/ordering/undated, resolution, redaction for `/diary/`, share URL, leave-by-document for `/diary/`.
- Live round-trip (`test-ugc-roundtrip.mjs`): create share, read via POST, GET refused, text hidden then shown when toggled, stop → NULL.
- Visual QA on a `/test/diary-fixture` (real catalog shows, made-up entries) at 360–1440, owner approval.
- Prod smoke after land: unknown token → 404 page with noindex/no-referrer; owner trial from their own diary.

### 3.5 Rollout

1. Wait for BRO-4558 (Diary card restyle) to land.
2. Sprint A: migration + SQL tests + live round-trip; apply.
3. Sprint B: extract diary cards, page, view model, OG card, analytics.
4. Sprint C: owner share sheet (generalised), Diary Share button.
5. Land together (B+C), prod smoke, owner trial. iOS joins plans' Sprint 5.

## 4. Risks

- **Review text is personal.** Mitigation: off by default in the DB and UI, filtered in SQL, SQL test proves absence.
- **Big diaries** (1,000+ entries): cap + total, server-rendered list; grid uses lazy-loaded posters.
- **Extraction churn on My Shows** (third session in a week touching it): sequence after BRO-4558; extraction "moved unchanged" with My Shows screenshots before/after.
- **Old shows not in the catalog** (diary-only imports): resolved through the same catalog/diary stub rule as plans; unresolvable rows are dropped and counted out of the header total.
