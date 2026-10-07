# My Shows: match the iOS Diary/Watchlist design (BRO-4558)

Source of truth: `thomaspryor/broadwayscorecard-app` `app/(tabs)/watched.tsx`,
`app/(tabs)/to-watch.tsx`, `components/user/DiaryListView.tsx`.
Web: `src/app/my-shows/MyShowsClient.tsx`, shared cards in
`src/components/user/upcoming-cards.tsx` (BRO-4481).

Out of scope: the app's calendar view, the tab structure, the list view's row
design (already iOS-style for Upcoming), Shared Plans page layout.

## One shared poster card, not a second design

`UpcomingGridCard` (upcoming-cards.tsx) is already the iOS grid card: poster,
centered dark date pill (`bg-black/45`, 12px bold), 2-line 12px centered name
with a reserved 30px min height. Generalize it instead of forking:

- Rename the body to `PosterGridCard` and keep `UpcomingGridCard` as an alias
  (Shared Plans keeps working unchanged).
- New optional props: `overlay` (extra nodes inside the poster box, for the
  diary card's edit/delete/note-preview), `meta` (node between poster and
  name, for stars), `removeLabel` + `removeOnMobile` (the remove button today
  is `hidden sm:flex`; To be rated needs a phone-visible "didn't see it").
- Export `formatPillDate(date, {year?, countdown?})` so every caller formats
  the pill the same way ("Oct 9", "Oct 9, 2024", "Oct 9 · 3d",
  "Oct 9 · Today!", "Oct 9 · Tomorrow"; countdown only for 0..7 days, as
  to-watch.tsx 275-286).
- New `SectionBand` component: full-width band, `bg-surface-raised`,
  `border-y border-white/5`, `-mx-4 sm:-mx-6 px-4 sm:px-6 py-2`, `<h3>` 13px
  bold uppercase `tracking-wider text-white` on the left, "N entries"
  `text-xs text-gray-500` on the right. `tone="amber"` variant for To be
  rated (title + 6px dot + count in amber-500, see below).

## 1. To be rated: 3-up poster grid on an amber band

Both the Diary's To Be Rated and the Watchlist's To Be Rated section.

- Section wrapper: `-mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-amber-500/[0.06]
  border-y border-amber-500/15` (iOS rgba(245,158,11,.06) / .15).
- Header: `TO BE RATED` + amber dot + count (iOS 1220-1226), no "N entries".
- Grid: same columns as every other My Shows grid (`grid-cols-3
  sm:grid-cols-4 gap-2`).
- Card: `PosterGridCard`, pill = planned date ("Sep 20") or "Rate", name
  below. Tap = `${showHref}?rate=1` (the show page opens the RatingEditor; the
  same deep link the old stars used, minus `stars=`). Remove ("didn't see
  it") stays reachable on phones via `removeOnMobile`, two-tap confirm.
- `ToBeRatedCard` (row with stars) is deleted; its "You saw these shows"
  subtitle goes too (the app has none).

## 2. Past-show grid: name under every poster

`DiaryGridCard` becomes a `PosterGridCard`:
- Date moves from amber text under the stars onto the poster pill. Without
  year inside a year group (the band says the year); with year when the list
  is flat (Top Rated sort), as watched.tsx 551-556.
- Gold stars (existing `MiniStars filledOnly`) in `meta`, then the name.
- The card box (`bg-white/[0.02] border`) goes; cards sit bare on the page
  like Upcoming cards and the app.
- Edit/delete buttons and the note hover preview move into `overlay`
  unchanged (same aria labels, same phone-visible delete).

## 3. Watchlist Upcoming cards: date pill with countdown

Upcoming section (booked, future-dated) in grid view:
- `PosterGridCard` with pill "Oct 9 · 3d", no status badge (app: booked
  shows don't need "Tix on sale").
- The compact sun/moon/clock showtime row is removed from the grid card.
  Showtime stays editable in list view, which has the full picker.
- Under the name, two full-width 44px controls: "Change date"
  (`DatePickerButton`, gray, calendar icon) and the existing "Add to
  calendar" (`AddToCalendarButtons compact`). The app edits the date by long
  press; web has no long press, so it needs a visible control.
- Not yet booked and the A-Z flat list keep `WatchlistCard` (Add date, status
  badge, rate strip). Their name is added under the poster for consistency
  with every other grid card, and the showtime row is removed there too.

## 4. Section headers become bands

Replace every plain `<h3>` section header with `SectionBand`:
Diary: Upcoming, year groups ("No date" keeps its hint), All Rated.
Watchlist: Upcoming, Not yet booked. To be rated uses the amber band (1).
The separate "Past Shows" header above the year bands is dropped: the app
goes straight to year bands, and two stacked bands read as noise.
Each section becomes a `<section>` so tests can scope by section.

## Tests

Update `tests/e2e/my-shows-mock.spec.ts`: To Be Rated now has poster cards
(assert names + `?rate=1` link, no stars, no subtitle); "Past Shows" heading
expectation goes; the mobile 20px star test for To Be Rated goes; the
date-wheel test scopes by `section` instead of `h3.parentElement`. Visual
baselines regenerate via test-ugc.yml `update_snapshots=true` after landing.

## Verification

1. `npx tsc --noEmit`, `npx next lint`.
2. `RUN_UGC_TESTS=1 TEST_BASE_URL=http://localhost:3456 npx playwright test
   tests/e2e/my-shows-mock.spec.ts`.
3. `node scripts/visual-qa.mjs --url http://localhost:3456 --paths
   '/my-shows?mock=1,/my-shows?mock=1&tab=watchlist' --elements
   '[data-testid=my-shows-content]'`: 0 overflow findings 360-1440.
4. Phone + desktop screenshots (Diary grid, Diary list, Watchlist) next to
   the app's design for the owner; push only after "ship it".

## Revisions after /second-opinion

1. One remove mechanism: `PosterRemoveButton` (two-tap confirm, always
   visible on phones, hover-revealed from `sm`) is extracted and used by every
   poster card. `PosterGridCard` takes `onRemove` + `remove={{label,
   confirm}}`; the diary card's delete goes through it ("Delete rating" /
   "Delete?"), so no card carries two confirm states. No `removeOnMobile`
   flag: phone-hidden remove was the #270 bug, so it is never the default.
   Watchlist Upcoming keeps `aria-label="Remove from watchlist"`.
2. `PosterGridCard` props: href, posterUrl, date, title, ariaLabel, badge,
   onRemove/remove, meta, footer, children (extra poster overlay). To be
   rated passes `ariaLabel="Rate X"`.
3. The pill is width-bounded (`max-w-[calc(100%-8px)] truncate`) so a long
   countdown can never overflow a 104px card at 360px.
4. To be rated is always the poster grid, in list view too (as in the app,
   where it ignores the grid/list switch).
5. `SectionBand` is also used by Shared Plans (`SharedPlansView`), whose
   header comment already promises "same section header as My Shows".
6. "Change date" is a `variant` of My Shows' `DatePickerButton`, not a
   styling hack. Showtime remains editable in list view only (accepted
   trade-off: the grid's showtime icons were the untappable part).
7. Extra test updates: `my-shows-mock.spec.ts` star-radiogroup count and
   watchlist rate-strip tests, `ugc-interactive-qa.spec.ts` diary star count
   and "Past Shows" lookup.
