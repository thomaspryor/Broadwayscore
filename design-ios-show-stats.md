# iOS Show Stats — Design Spec ("My Scorecard") · v2

**Status:** Design proposal · 2026-07-26 (v2 — owner priorities layered onto the full v1 scope)
**Target:** BroadwayScorecard iOS app (`thomaspryor/BroadwayScorecard-app`)
**Companion sketch:** `design-ios-show-stats-mockup.html` — **layout sketch for
direction only, NOT the proposed design.** Per
`memory/feedback_ios_design_conservative_real_tokens.md` and the app repo's
CLAUDE.md "Design Proposals": anything presented as *the* design must be
implemented on the app's real `theme.ts` tokens/components and captured from the
simulator, as 2–3 rendered options per screen.

---

## 0. Owner priorities (v2 — additive, nothing from v1 is dropped)

1. **Good looking, clean, modern**
2. **Broadway Theaters visitor tracking**
3. **Existing design system only** — no new tokens, typefaces, or colors
4. **Shows per year tracking**
5. **Feed with photos** attached to show logs — **private only**

v2 changes vs. v1: the Feed is promoted from "activity parity" to a core module
with photo logging; Theaters and Shows-per-year lead the stats screen; the v1
signature modules (You vs. Critics, Tony & Canon, People, Curtain Call) are
**all retained** and sequenced right behind the priority set; the v1 visual
inventions (chart-specific gold `#c48119`, serif/mono display type) are
**removed** per priority 3 — see §9.

## 1. Thesis

Mezzanine's stats tab answers *"how much theater have I seen?"* — shows by
year, a ratings histogram, a theater map, two completion rings. Every number
comes from the user's own diary and nothing else.

Broadway Scorecard's unfair advantage is that **every diary entry lands inside
a scored universe**: 1,500+ mobile shows with critic scores, audience grades,
Tony tags, runtimes, casts/creatives, and theater metadata. So our stats
feature answers questions Mezzanine structurally can't:

1. **"What kind of theatergoer am I?"** — taste vs. the critics and the
   audience, genre mix, generosity as a rater.
2. **"Where do I stand against the canon?"** — Tony winners seen, Critical
   Gold coverage, theater completion, most-seen composers and performers.
3. **"What's my story?"** — a private photo scrapbook of every night at the
   theater, and a shareable Curtain Call annual recap.

Design principle: **every number is a door, not a plaque.** Every stat taps
through to the list of shows behind it. No dead-end numbers.

Inspiration audit:

| Source | What we take |
|---|---|
| Letterboxd stats / Year in Review | year drill-down, most-watched people, milestone-list progress, ratings histogram vs. community |
| The StoryGraph | genre donuts, "your average vs. community" framing, rich year wrap-up |
| Goodreads Year in Books | superlatives (longest/shortest, most/least popular) |
| Trakt VIP | hours watched as hero stat, day-of-week habits, all-time records |
| Spotify Wrapped / Apple Replay | story-card share format, one bold stat per card |
| Strava | personal records, streaks, "your biggest month" |
| Mezzanine | shows-by-year bars, theater map, completion rings, activity feed — kept, then extended |

## 2. Information architecture

- **Stats:** Profile tab → segmented control (Grid · Feed · Stats), matching
  the Mezzanine mental model users already have. A compact "Your 2026 so far"
  card on the home screen links here in December.
- **Feed:** the diary timeline itself (§4) — photos make it a private
  scrapbook, not a social feed.
- **Scope pill** (All time / 2026 / 2025 …) pinned under the Stats header;
  filters every module.

**Stats module order (v2):**
1. Marquee numbers (hero tiles)
2. **Shows per year** ← priority 4
3. **Broadway theaters** ← priority 2
4. Ratings
5. You vs. the Critics ⭐
6. Tony & the Canon ⭐
7. People ⭐
8. The Mix
9. Records & Superlatives
10. Habits & Streaks
11. Curtain Call teaser (Nov–Jan) / share hub

⭐ = differentiators Mezzanine cannot build. Modules hide below data
thresholds (§7).

## 3. Priority modules

### 3.1 Marquee numbers (hero)
Four stat tiles: **Shows** (diary count), **Hours in a seat** (Σ runtime `rt`,
fallback 2h30m musicals / 2h plays; sub-label converts to days), **Theaters**
(distinct venues), **This year** (count + ▲/▼ pace vs. same date last year).
Tabular numerals; animated `numericText` transitions.

### 3.2 Shows per year (priority)
Bar chart, one bar per year (Swift Charts; brand-gold bars, selected bar
highlighted with a count label — selective labeling only).
- Tap a bar → scopes the whole screen to that year; bars become months.
- Records strip beneath: busiest month ever, current streak of consecutive
  months with a show, longest drought. Each pill taps to its shows.

### 3.3 Broadway theaters visitor tracking (priority)
Parity with Mezzanine's rings + map, then deeper, using
`data/theater-metadata.json` (capacity, opened, notes — 43 houses):
- **Completion ring:** "Broadway houses · 37 of 41" — only currently-operating
  houses in the denominator; closed/renamed houses listed as "extra credit"
  so 100% stays reachable. West End ring alongside when WE visits exist.
- **The house checklist** (the module people screenshot): all 41 houses as a
  scannable grid — visited chips filled (brand-muted bg, visit count),
  unvisited outlined. Tap any house → detail sheet: your shows there (posters
  + dates), capacity, opened year, current tenant (venue join against
  `mobile-shows.json`). **Unvisited sheets show what's playing there now + a
  ticket link** — the completion mechanic feeds actual bookings.
- **House records:** home theater (most visits), biggest/smallest house
  you've sat in (capacity), oldest house (opened year).
- **Map (v1.1, MapKit):** world view clusters by city; pinch into NYC/London
  flips to one pin per house — filled visited, outlined not. Needs lat/lng in
  theater metadata (+ a West End equivalent) — small data task in this repo.
- Venue matching: diary entries carry `venue` strings from the Mezzanine
  catalog import; normalize against `theater-metadata.json` keys.

### 3.4 Ratings
Half-star histogram 0.5–5.0 with your-average marker (neutral ink — no second
accent hue). Footer: "186 of 195 shows rated" → taps to the unrated list.
**Community ghost overlay** (outline distribution of all-app ratings for the
same shows, "you rate +0.3★ above the crowd") ships once app rating volume
exists (k≥5 aggregate, §8) — until then the module is yours-only.

## 4. The Feed — private photo scrapbook (priority)

Mezzanine's feed is text ("You added X to your diary"). Ours becomes the
**private visual record of your theatergoing.** Nothing here is ever public.

### Logging
- The log sheet (rate/date/venue) gains **Add photos** (up to 6 per entry):
  Playbill, marquee, curtain call, your seat view.
- **iOS-native assist:** with photo-library permission, an on-device PHAsset
  query for photos taken on `date_seen` (that evening, optionally near the
  venue when geo available) surfaces a "From that night" picker row — one tap
  to attach, including retroactively on historical entries. The query runs
  entirely on-device; nothing is scanned server-side.

### Feed
- Timeline grouped by month headers; each entry card: poster thumb, title,
  ★ rating, venue · date, note snippet, **photo strip** (rounded thumbs, tap →
  full-screen pager with pinch zoom).
- View toggle: **Timeline · Photo wall** (edge-to-edge grid of every photo,
  each tapping back to its entry) **· Poster grid** (Mezzanine-parity wall).
- Camera glyph on diary rows with photos; photoless entries get a gentle
  "Add the Playbill 📸" prompt.

### Privacy model (non-negotiable)
- Feed and photos are **visible to the owner only** — no follower visibility,
  no public surface, regardless of future social features.
- Storage: **Supabase Storage private bucket** (`diary-photos/{user_id}/…`),
  owner-only RLS, consistent with the existing auth stack; client-side
  downscale to ~2048px + EXIF GPS strip on upload. (CloudKit private DB is
  the zero-server alternative; decide in the app repo.)
- Photos never auto-appear on share cards or exports; including one is always
  an explicit per-share selection.
- Schema: `user_review_photos (id, review_id FK, user_id, storage_path,
  width, height, taken_at, position)`.

## 5. Signature modules (retained from v1, sequenced after priorities)

### 5.1 You vs. the Critics ⭐
Joins `user_reviews.rating` (×20 → 0–100) against `cs` from mobile-shows.
- **Taste alignment gauge:** % of rated shows within ±10 pts of the critic
  score, with a friendly label ("In step with the critics 72%" / "Certified
  contrarian"); Spearman ρ as fine print.
- **Contrarian picks:** largest deltas both directions — *"You loved it,
  critics didn't"* / *"Critics raved, you shrugged"* — poster, title, your ★,
  critic score chip (score-tier colors, semantic use only), delta badge.
  Screenshot-bait and a one-tap share card.
- **Critical Gold coverage:** of open shows scoring 83+, how many you've seen
  ("7 of 11") — the unseen remainder is a to-see list deep-linking to show
  pages/tickets. Stats → intent → booking.
- Lighter one-row repeat for **audience grade** ("The audience agrees with
  you 81% of the time").

### 5.2 Tony & the Canon ⭐
Milestone checklists with progress rings + poster shelves (unseen posters
dimmed): **Best Musical winners**, **Best Play winners**, **this season's
nominees** (live during Tony season from `tony-nominations.json`), **NYT
Critic's Picks** (`nyt-pick` tag). Plus **"Saw it before it won"** — diary
`date_seen` < ceremony date. The purest theater flex; badge-worthy.

### 5.3 People ⭐
From `ct` (cast + creatives): most-seen performers, composers/writers,
directors — rows with count + mini poster strip. Crossing ×3 auto-creates a
micro-collection ("Your Sondheim count: 6").

### 5.4 The Mix
Musicals vs. plays (donut — brand gold + `surface-overlay` fills, direct
labels; identity never carried by a second accent hue), revivals vs. originals
(`rv`), top genres from `tg`, and an **earliness profile** (% seen in
previews / first month / later — "an early adopter: 34% in the first month").

### 5.5 Records & Superlatives
One-line rows with posters: longest show sat through (`rt`), shortest; most
popular show you've seen (app-wide rating counts) vs. deepest cut; highest/
lowest critic score seen ("and you gave it 4★ — no regrets"); first diary
entry; 100th/200th show with dates; best-rated year.

### 5.6 Habits & Streaks
Day-of-week split ("a Saturday person, 41%"), month × year heatmap (single-hue
brand-gold ramp), most shows in a week/month, longest monthly streak.
(Matinee vs. evening needs showtime capture — §8 backlog.)

### 5.7 Curtain Call — the year in review ⭐
Unlocks Nov 15 (data through Dec 31, available all January), push
notification. Eight swipeable full-screen cards, each exportable 9:16 + 1:1
via SwiftUI `ImageRenderer` (no server): cover collage → the numbers → your
year in bars → top-five poster podium → taste card (alignment + most
contrarian take) → people card → canon card (Tonys seen, houses unlocked) →
sign-off + share CTA. Every export carries the wordmark + App Store QR — the
acquisition moment. Cards use share-safe data only; feed photos are never
auto-included (explicit pick only).

## 6. Interaction grammar & sharing

- Scope pill filters every module; numbers animate.
- **Every stat row/chart element taps** → filtered diary list → show pages.
- Swift Charts; 44pt hit targets; VoiceOver summaries ("Sixty shows in 2025,
  your busiest year"); haptic tick when a ring crosses a milestone.
- Share glyphs on module headers render branded cards (same templates as
  Curtain Call). Sharing is always explicit; the diary and feed stay private.

## 7. Empty & sparse states

- < 3 diary entries: ghost-chart preview + "Log 3 shows to open your
  Scorecard" progress dots.
- Thresholds: Ratings ≥ 5 rated; You-vs-Critics ≥ 5 rated with `cs`; People
  ≥ 10 entries; Habits ≥ 10 dated entries. Below threshold → module hides.
- **Mezzanine import is the cold-start CTA** (importer already exists on web):
  "Bring your Mezzanine diary with you" → instantly full stats. The switching
  story.
- Diary-only entries (32k catalog) count toward totals, theaters, habits;
  they don't join critic-score modules — footnote mirrors Mezzanine's own
  "177 of 195 have a location" pattern.

## 8. Data plan (this repo)

Shipped already: `mobile-shows.json` (`v`, `rt`, `cs`, `ag`, `tg`, `ct`, `od`,
`rv`), `theater-metadata.json` (capacity/opened, 43 houses), diary catalog
rows (venue/city/country). New artifacts:
1. **Theater lat/lng** (+ West End file, ≈39 houses) for the map — v1.1.
2. **`stats-canon.json`** — Tony Best Musical/Play winners (year, showId|null,
   title, poster), ceremony dates, NYT picks, Pulitzers — v1.1/v2.
3. **Community rating distributions** — per-show aggregate histograms (k≥5)
   for the ratings ghost — v2, volume-dependent.
Supabase: `user_review_photos` table + private storage bucket (§4).
Capture backlog (app-side, optional log-sheet fields): seat + price paid
(→ spend stats), showtime (matinee/evening), companions.

## 9. Visual language — existing design system ONLY

Per owner rule (recorded in
`memory/feedback_ios_design_conservative_real_tokens.md`):

- **Type:** system font (SF) only. No serif, no monospace display, no new
  typefaces anywhere. Tabular numerals for stats.
- **Color:** only existing tokens — surfaces
  (`#0f0f14 / #1a1a24 / #2a2a38 / #32323f`), text scale, brand gold `#d4a574`
  (+ hover/light/muted variants), score-tier green/amber/red used **only** as
  semantic score chips, status tokens. **No new chart colors:** charts are
  single-hue brand-gold marks on surface grounds; two-category charts get
  identity from direct labels with gold + `surface-overlay` fills.
- **Components:** existing card, score chips, status badges, list rows. Bold
  choices are **layout/IA only** — a screenshot must be indistinguishable in
  font + color from the current app.
- **Process:** design proposals = implement on real tokens in a
  BroadwayScorecard-app worktree → simulator screenshots → 2–3 options per
  screen (one faithful-polish, one bolder layout), per the app CLAUDE.md.

## 10. Phasing

- **V1 — priorities + core:** hero tiles, shows per year, Broadway theater
  tracker (ring + checklist + records), ratings histogram, records &
  superlatives, scope pill, tap-through lists, **photo logging + Feed
  (timeline / photo wall / grid)**. Pure `StatsEngine` struct over diary +
  `mobile-shows.json` (unit-tested reducers).
- **V1.1:** You vs. Critics/Audience, Tony & Canon (`stats-canon.json`),
  People, MapKit theater map (lat/lng artifact), share cards.
- **V2 (December):** Curtain Call story + push unlock, community ghost
  overlay, Habits heatmap, The Mix earliness profile, milestone toasts
  ("that was show #200 🎉").
