# iOS Show Stats — Design Spec ("My Scorecard")

**Status:** Design proposal · 2026-07-26
**Target:** BroadwayScorecard iOS app (`thomaspryor/BroadwayScorecard-app`)
**Companion mockup:** `design-ios-show-stats-mockup.html` (5 annotated screens)

---

## 1. Thesis

Mezzanine's stats tab answers *"how much theater have I seen?"* — shows by year, a
ratings histogram, a theater map, two completion rings. It's good, but every number
comes from the user's own diary and nothing else.

Broadway Scorecard's unfair advantage is that **every diary entry lands inside a
scored universe**: 1,500+ mobile shows with critic scores, audience grades, Tony
tags, runtimes, casts/creatives, and theater metadata. So our stats feature answers
three questions Mezzanine structurally can't:

1. **"What kind of theatergoer am I?"** — taste vs. the critics and the audience,
   genre mix, generosity as a rater.
2. **"Where do I stand against the canon?"** — Tony Best Musical winners seen,
   Critical Gold coverage, theater completion, most-seen composers and performers.
3. **"What's my story this year?"** — a shareable, Wrapped-style *Curtain Call*
   annual recap.

Design principle: **every number is a door, not a plaque.** Every stat taps through
to the list of shows behind it. No dead-end numbers.

Inspiration audit (what we're stealing and from whom):

| Source | What we take |
|---|---|
| Letterboxd stats / Year in Review | year drill-down, most-watched people, milestone-list progress, ratings histogram vs. community |
| The StoryGraph | mood/genre donuts, "your average vs. community" framing, rich year wrap-up |
| Goodreads Year in Books | superlatives (longest/shortest, most/least popular) |
| Trakt VIP | hours watched as hero stat, day-of-week habits, all-time records |
| Spotify Wrapped / Apple Replay | story-card share format, one bold stat per card |
| Strava | personal records, streaks, "your biggest month" |
| Mezzanine itself | shows-by-year bars, theater map, completion rings — we keep all of it, then go further |

---

## 2. Placement & information architecture

- **Entry point:** Profile tab → segmented control (Grid · Activity · **Stats**), same
  position Mezzanine uses so switchers feel at home. Also surface a compact
  "Your 2026 so far" card on the app home screen in December linking here.
- **Scope selector (global):** `All time ▾` pill pinned under the header —
  All time / 2026 / 2025 / … Every module below re-filters. (Letterboxd's
  all-time vs. per-year split, but one screen instead of separate pages.)
- **Module order** (one scrolling screen, each module a card):
  1. Marquee numbers (hero)
  2. Shows over time
  3. Ratings
  4. You vs. the Critics ⭐
  5. Tony & the Canon ⭐
  6. Theaters (map + completion)
  7. People ⭐
  8. The Mix (musicals/plays, revivals, genres)
  9. Records & Superlatives
  10. Habits & Streaks
  11. Curtain Call teaser (Nov–Jan) / share hub

⭐ = differentiators Mezzanine cannot build. Modules hide themselves below data
thresholds (see §6).

---

## 3. Module specs

### 3.1 Marquee numbers (hero)
Four stat tiles: **Shows** (diary count), **Hours in a seat** (Σ runtime `rt`,
fallback 2h30m musicals / 2h plays; sub-label converts to days), **Theaters**
(distinct venues), **This year** (count + ▲/▼ vs. same date last year).
Sub-copy personalizes: "≈ 20 full days of theater."

### 3.2 Shows over time
Bar chart, shows per year (per month when a single year is scoped). Tap a bar →
scope that year. Callouts under the chart: busiest month ever, current streak of
consecutive months with a show, longest drought. (Bars: chart-gold; selected bar
gets the brand highlight + count label — selective labeling, not every bar.)

### 3.3 Ratings
Half-star histogram 0.5–5.0 of the user's ratings with two overlays:
- **Your average** marker (e.g. 3.8★).
- **Community ghost** — outline distribution of all-app ratings for the *same
  shows*, so the copy can say "You rate 0.3★ above the crowd — a generous rater"
  or "a tough crowd of one."
Footer: "186 of 195 shows rated" + tap → unrated list (nudge to complete).

### 3.4 You vs. the Critics ⭐ (signature module)
Everything here joins `user_reviews.rating` (×20 → 0–100) against `cs` from
mobile-shows.
- **Taste alignment gauge:** % of rated shows within ±10 pts of the critic score,
  displayed as a friendly label ("In step with the critics 72%" / "Certified
  contrarian"). Spearman correlation shown as fine print for nerds.
- **Your contrarian picks:** two lists of the largest deltas —
  *"You loved it, critics didn't"* and *"Critics raved, you shrugged"* — each row:
  poster, title, your ★, critic score chip (score-bucket color), delta badge.
  This is the screenshot-bait row; it's also a share card (§5).
- **Critical Gold coverage:** of currently-open shows scoring 83+, how many
  you've seen ("You've seen 7 of 11 Critical Gold shows running now") with the
  remainder as a tappable to-see list → deep-link to show pages / tickets.
  Turns stats into a booking loop — no other tracker closes that loop.
- Repeat as a lighter one-row module for **audience grade** ("The audience agrees
  with you 81% of the time").

### 3.5 Tony & the Canon ⭐
Letterboxd milestone-lists, theaterized. Checklist collections with progress
rings + poster shelves:
- **Tony Best Musical winners seen** (all-time list, pre-computed)
- **Tony Best Play winners seen**
- **This season's nominees** (live during Tony season — from `tony-nominations.json`)
- **Saw it before it won:** count of shows attended *before* their Tony win
  (diary `date_seen` < ceremony date). Pure flex stat; badge-worthy.
- **NYT Critic's Picks seen** (tag `nyt-pick`).
Each collection: ring (n of N), horizontal poster shelf — seen posters full-color,
unseen dimmed at 20% (completionist itch, StoryGraph-challenge style).

### 3.6 Theaters
Keep Mezzanine's map, then beat it at street level:
- **Map (MapKit):** world view clusters by city (their feature, parity), but
  pinch into NYC/London flips to **theater-district mode** — one pin per house,
  gold = visited, outline = not yet. Requires lat/lng in theater metadata (§7).
- **Completion rings:** Broadway n/41, West End n/39 (their feature, parity) —
  but each ring taps into a **house grid**: every theater as a chip, visited
  chips gold with visit count, unvisited dimmed. The "bingo card" people screenshot.
- **House records:** most-visited house ("Your home theater: the Shubert, 9
  shows"), biggest house visited (capacity from theater-metadata), smallest,
  oldest. Sub-stat: "Seen a show in every currently-operating Shubert house" style
  operator sub-rings later.

### 3.7 People ⭐
Letterboxd's most-watched actors/directors, from `ct` (cast + creatives):
- **Most-seen performers** (appearances across your diary, cast-change aware
  where data allows), **most-seen composers/writers**, **most-seen directors**.
- Rows: avatar/initial, name, count, mini poster strip of the shows.
- Auto-generated micro-collections: "Your Sondheim count: 6" when a creative
  crosses 3+.

### 3.8 The Mix
- Donut: **musicals vs. plays** (chart-gold vs. purple, direct-labeled, 2px gaps).
- Donut/bar: **revivals vs. originals** (`rv`), with "You lean revival, 61%".
- **Genre bars** from `tg` tags (top 6 + Other).
- **Earliness profile:** % seen in previews / first month / after year one —
  "You're an early adopter: 34% of your shows were in their first month."

### 3.9 Records & Superlatives
Goodreads Year-in-Books energy, one-line rows with posters:
longest show sat through (`rt`), shortest; most popular show you've seen (by
app-wide ratings count) vs. **deepest cut** (fewest); highest critic score seen,
lowest ("and you gave it 4★ — no regrets"); first diary entry ever; 100th/200th
show with date; best-rated year ("2024 — your golden year, 4.1★ avg").

### 3.10 Habits & Streaks
- Day-of-week split (Trakt-style) — "You're a Saturday person (41%)."
- Season heatmap: month × year grid, cells shaded by count (sequential ramp of
  chart-gold).
- Records: most shows in one week/month; current & longest monthly streak.
- (Matinee vs. evening needs showtime capture — see §7 backlog.)

### 3.11 Curtain Call — the year in review ⭐
Every December (unlock: Nov 15, data through Dec 31, available all January):
full-screen swipeable story, 8 cards, each also exportable:
1. Cover: "Your 2026 at the theater" + poster collage
2. The numbers (shows, hours, theaters, cities)
3. Your year in bars (months) + busiest week
4. Your top 5 (by your rating, ties by recency) — poster podium
5. Taste card: alignment %, most contrarian pick of the year
6. People card: most-seen performer/composer of the year
7. Canon card: Tony winners/nominees seen this year, houses unlocked
8. Sign-off: "See you at the theater in 2027" + share CTA
Push notification on unlock. This is the acquisition moment — every export
carries the wordmark + App Store QR (§5).

---

## 4. Interaction grammar

- **Scope pill** filters every module; modules animate number transitions
  (SwiftUI `contentTransition(.numericText())`).
- **Every stat row/chart element is tappable** → filtered diary list ("the shows
  behind this number"), from which each show opens normally.
- Charts are Swift Charts; bars/cells get 44pt hit targets; VoiceOver reads
  chart summaries ("Sixty shows in 2025, your busiest year").
- Haptic tick when a ring crosses a milestone on screen entry (subtle, once).

## 5. Sharing

Every module header has a share glyph → renders a branded card via SwiftUI
`ImageRenderer` (no server round-trip): 9:16 story + 1:1 square, dark
stage-black ground, gold accents, wordmark + QR footer. Card templates:
marquee numbers, contrarian picks, theater bingo grid, any canon shelf, each
Curtain Call card. Posters on share cards use the same `img.po` assets the app
already ships. Privacy: sharing is always an explicit export; nothing is public
by default (diary stays private — unchanged).

## 6. Empty & sparse states

- < 3 diary entries: stats tab shows a friendly preview with ghost charts +
  "Log 3 shows to open your Scorecard" progress dots.
- Module thresholds: Ratings ≥ 5 rated; You-vs-Critics ≥ 5 rated with `cs`;
  People ≥ 10 entries; Habits ≥ 10 dated entries; below threshold the module
  hides (never renders embarrassing single-bar charts).
- **Mezzanine import is the cold-start solution:** the web app already imports
  Mezzanine CSV (`MezzanineImport`); surface the same importer here in the empty
  state ("Bring your Mezzanine diary with you") — instantly full stats. This is
  the switching story.
- Diary-only entries (32k-show catalog, no scores) participate in counts,
  theaters, habits; they simply don't join critic-score modules — footnote
  "177 of 195 shows have a score" mirrors Mezzanine's own pattern.

## 7. Data plan (this repo's side)

Already shipped in `public/data/mobile-shows.json`: `cs`/`cr` (critic), `ag`
(audience grade), `tg` (tags incl. `tony-winner`, `nyt-pick`), `rv` (revival),
`rt` (runtime), `ct` (cast/creatives), `v` (venue), `od` (opening date).
User side (Supabase): `user_reviews.rating/date_seen`, watchlist, lists.

New build artifacts needed (add to `generate-mobile-artifacts.sh`):
1. **`stats-canon.json`** — pre-computed lists: Tony Best Musical/Play winners
   (year, showId|null, title, poster), NYT picks, Pulitzer winners; ceremony
   dates for "saw it before it won."
2. **Theater geo + metadata for mobile** — `theater-metadata.json` already has
   capacity/opened for 43 Broadway houses; add `lat`/`lng` and a West End
   equivalent (≈39 houses) → `theaters.json` mobile artifact.
3. **Community rating distributions** — per-show histogram of app user ratings
   (privacy: aggregate counts only, k≥5) for the ratings ghost overlay; until
   volume exists, fall back to audience-score-derived expectation or hide.
4. Diary catalog rows (Mezzanine import shows) already carry `venue/city/
   country` — no change.

Capture backlog (app-side, optional fields on the log sheet, all feeding later
stats): seat + price paid (→ spend stats, avg per show — no tracker does this
well), showtime (matinee/evening), companions.

## 8. Phasing

- **V1 (all offline-computable from diary + mobile-shows):** hero numbers,
  shows over time, ratings histogram (no ghost), the Mix, records &
  superlatives, theater completion rings + house grid (no map), scope pill,
  tap-through lists. ~2 wk of SwiftUI + a pure `StatsEngine` struct (unit-test
  the reducers).
- **V1.1:** You vs. Critics/Audience, Tony & Canon (needs `stats-canon.json`),
  People, MapKit theater map (needs geo), share cards.
- **V2 (Dec):** Curtain Call story + push unlock, community ghost overlay,
  habits heatmap, milestone toasts/badges ("That was show #200 🎉").

## 9. Visual language (mockup: `design-ios-show-stats-mockup.html`)

Stage-dark ground `#0f0f14`, cards `#1a1a24` (app surface tokens); ink is warm
cream; brand gold `#d4a574` for UI accents/headers. **Chart marks** use a
deepened gold `#c48119` paired with purple `#a855f7` — the pair passes the
dataviz palette validator on the dark surface (lightness band, chroma, CVD ΔE
32.4, contrast ≥3:1); score-bucket green/amber/red appear only as semantic
score chips, never as series colors. System type (SF), tabular numerals for all
stats. Single dark theme is deliberate: this is theater — the lights are down.
