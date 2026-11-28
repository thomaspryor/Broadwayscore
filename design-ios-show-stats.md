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
- **Scope pill** pinned under the Stats header; filters every module. Two
  interleaved scope families, both kept: **seasons** ("2025–26 Season" — the
  primary unit; theater years end with the Tonys, not December) and **calendar
  years** (2026, 2025 …), plus All time. Section headers: All time · Seasons ·
  Years. Default after first launch: current season.

**Stats module order (v2.1 — trimmed after external review, §11):**
1. Marquee numbers (hero tiles)
2. **Shows per year** ← priority 4
3. **Broadway theaters** ← priority 2
4. You vs. the Critics ⭐ (incl. **Aisle Mates** — critics you most align
   with — and **Your Paper of Record** for outlets)
5. Tony & the Canon ⭐
6. Ratings
7. People ⭐
8. The Mix
9. Records & Superlatives (absorbs the fun one-offs; includes the
   total-audience counter, §5.5)
10. Curtain Call teaser (June + Nov–Jan) / share hub

⭐ = differentiators Mezzanine cannot build. Modules hide below data
thresholds (§7). **Habits & Streaks is cut as a standalone module** (generic
tracker fluff — both external reviewers); its two good stats (busiest month,
current streak) already live in the Shows-per-year records strip.

## 3. Priority modules

### 3.1 Marquee numbers (hero)
Four stat tiles: **Shows** (diary count), **Hours in a seat** (Σ runtime `rt`;
fallback 2h30m musicals / 2h plays — if >25% of entries rely on the fallback,
demote the tile below the hero until real-runtime coverage improves),
**Theaters** (distinct venues), **This period** — the tile label is
**scope-aware and literal** ("This season so far" / "2026 YTD") and pace is
computed within the active scope only, never mixing season and calendar
frames. Tabular numerals; animated `numericText` transitions.

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
  each tapping back to its entry). The Mezzanine-parity poster wall already
  exists as the profile Grid tab — a third in-feed view was redundant (cut on
  external review).
- Camera glyph on diary rows with photos. **The text-only feed must look
  finished, not like a failure state:** photoless entries render as clean
  poster+note cards; the "Add the Playbill 📸" prompt appears at most once per
  visible screen and can be dismissed per-entry — a text-only diary is a
  first-class mode, not nagware.

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

### App Store & platform checklist (from external review)
- Clear `NSPhotoLibraryUsageDescription` purpose string; full **Limited
  Library** support with an in-app "Manage Photos Access" row; the "From that
  night" suggestion row only appears behind an explicit affordance, never as
  an unprompted scan.
- Location-based suggestions (if enabled) need `NSLocationWhenInUse` with
  narrow copy + a toggle to disable; date-only matching is the default.
- Upload queue with retry/background task, Wi-Fi-only preference, visible
  failure states on the card; per-entry and bulk photo delete.
- **"Export & delete all photos"** control in settings; privacy policy +
  App Store privacy labels declare cloud storage and retention.
- App Review may reflexively demand UGC report/block flows: pre-empt in the
  review notes — photos are owner-visible only, not discoverable by any other
  user, so moderation surface doesn't apply.
- Relentless privacy reassurance in-UI: lock badge on the feed header,
  one-time onboarding line ("Your feed is a private scrapbook — only you can
  ever see it").

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
  pages/tickets. Stats → intent → booking. *Ticket-link hygiene (external
  review): consistent deeplink targets, affiliate disclosure where links are
  monetized, and regional availability handling — otherwise it reads as adware
  inside a diary.*
- Lighter one-row repeat for **audience grade** ("The audience agrees with
  you 81% of the time"), plus a **critics-vs-audience divergence row** scoped
  to your shows: "On your 195 shows, critics and audiences agreed 80% of the
  time — they were worlds apart on Bad Cinderella." Reinforces the app's data
  authority with zero new data.

#### Aisle Mates — the critics you most align with ⭐

Individual-critic alignment, not just the aggregate. Press seats are aisle
seats — your best-matched critics are your **Aisle Mates**. (Name candidates
considered: Critic BFFs, Kindred Critics, Taste Twins; "Aisle Mates" wins for
being theater-native. Trivial to rename.)

- **Top matches:** for every critic sharing ≥5 rated shows with your diary,
  alignment = % of shared shows where |your ★×20 − their score| ≤ 12
  (≈ half a star), tie-broken by overlap count. Show top 3:
  "**Ben Brantley — 91% aligned · 31 shows together**," with a signed-bias
  footnote ("runs 6 pts colder than you"). Corpus check (2026-07-26): 140
  critics have 25+ scored shows, 50 have 100+ — real diaries will match.
- **Calibration (measured, 2026-07-26):** pairwise alignment between major
  critics themselves spans only ~35–68% under the ±12pt window (top pair:
  Rooney × Feldman 68%/152 shows; Hofler is the corpus-wide nemesis, in 4 of
  the 5 least-aligned pairs). So display bands must be calibrated to that
  distribution — ~60%+ is "practically the same person," not a C grade — and
  final copy thresholds should be re-derived once real user diaries exist.
  User-vs-critic distributions may run higher (coarser half-star ratings);
  re-measure before locking copy.
- **Real-diary validation (owner's 107 ratings, 2026-07-26 — full report in
  claude-outputs/aisle-mates-report-2026-07-26.md):** the prediction above
  held — the owner's base rate vs a random qualifying critic is ~70% within
  ±12, higher than any critic-critic pair. Two spec changes adopted:
  1. **Volume floor for the top-mates ranking:** rank Aisle Mates among
     critics with **≥15 shared shows** (raw % at 5–6 shows put six
     small-sample critics above the true best match, Gardner 67%/49).
     Critics at 5–14 shared shows appear in a secondary "rising matches"
     row, never as the headline mate. Nemesis keeps ≥8 but the sheet also
     surfaces the highest-volume low-aligner (owner: Hofler 37%/70 — the
     corpus nemesis is his personal one too, which is the better story).
  2. **User-facing display bands** center near 60–65%: label ~67%+ as
     exceptional ("practically the same person"), ~55–65% as strong, below
     ~45% as nemesis territory. Do not reuse critic-critic bands.
- **Critic Nemesis:** lowest alignment at ≥8 shared shows, framed with love:
  "You and Jesse Green disagree 68% of the time. Keep him around for
  balance." The share-bait row.
- **Critic detail sheet:** the full agreement history (show · your ★ · their
  score), biggest agreement and biggest fight, and — the payoff — **"Their
  picks you haven't seen"**: your best-matched critic becomes your personal
  recommender, deep-linking to show pages/tickets. Same booking loop as
  Critical Gold.
- **Your Paper of Record:** the same math at outlet level (outlet's score per
  show, mean where multiple critics): "The outlet that reads you best:
  Vulture — 84% aligned across 52 shows," with tier context (T1/T2/T3) and a
  nemesis-outlet counterpart. Name puns on the NYT's moniker; works even
  when the answer *isn't* the Times ("Your paper of record is… the New York
  Post. No judgment.").
- **Share card:** "My Aisle Mate: Ben Brantley · 91% across 31 shows" /
  nemesis equivalent — same card engine as everything else.
- Hides below 5 shared rated shows with any single critic; cold-start copy
  points at rating more of the diary.
- Data: needs `stats-reviews.json` (§8) — per-show scored reviews, compact.

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
entry; 100th/200th show with dates; best-rated year. Plus the **total
audience counter** (Σ capacity of the house for every log): "You've shared a
room with ≈ 135,400 other theatergoers." Big, sticky, share-card-worthy.

### 5.6 Challenges — private lists with progress ⭐
The Letterboxd/StoryGraph loop, private-only: system challenges generated
from data we already have — "Every Shubert-org house," "All Best Musical
winners of the 2010s," "Critical Gold currently open," "This season's Tony
nominees (due by ceremony night)" — each a progress ring + poster shelf, with
unseen entries deep-linking to show pages. User-created private lists join
the same UI. Canon shelves (§5.2) and the theater checklist (§3.3) are
Challenges under the hood — one component, many instances. A lightweight
**"what to see next"** row synthesizes it: unseen high-scoring open shows,
weighted toward houses you haven't visited.

### 5.7 Curtain Call — two editions ⭐

Both share one card engine (eight swipeable full-screen cards, each
exportable 9:16 + 1:1 via SwiftUI `ImageRenderer`, no server): cover collage
→ the numbers → your period in bars → top-five poster podium → taste card
(alignment + most contrarian take) → people card → canon card → sign-off +
share CTA. Every export carries the wordmark + App Store QR. Cards use
share-safe data only; feed photos are never auto-included (explicit pick
only).

**Season Finale (flagship) — unlocks the morning after the Tony Awards.**
The theater year ends on Tony night, so this is the marquee recap:
- Covers the season window (see boundary rule below): "Your 2025–26 Season."
- Canon card becomes a **Tony-night scorecard**: nominees and winners you
  saw, "you'd seen 7 of the 10 Best Musical nominees before the ceremony,"
  saw-it-before-it-won additions this season.
- Push notification lands while Tony chatter is still hot — peak share moment.

**Year in Review — unlocks Nov 15, data through Dec 31, live all January.**
The calendar cut, kept for December-recap culture (Wrapped season): same
cards scoped to the calendar year, canon card in its general form.

**Season boundary rule:** a season runs from the day after one Tony ceremony
through the day of the next. Ceremony dates ship in `stats-canon.json`; for
the in-progress season (next ceremony unannounced), the provisional end is
June 30, corrected when the date lands. Shows logged on ceremony day count in
the season then ending.

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
   title, poster), ceremony dates, NYT picks, Pulitzers. Ceremony dates are
   needed at **V1** (they define season boundaries for the scope pill); the
   winner/nominee lists can land v1.1/v2.
3. **`stats-reviews.json`** — compact per-show scored reviews for Aisle
   Mates / Paper of Record: interned critic + outlet name tables, then
   `{showId: [[criticIdx, outletIdx, score], …]}`. ~19k scored reviews ≈
   ~500KB raw / ~100KB gzipped; alignment is computed on-device against the
   private diary (ratings never leave the phone for this) — v1.1.
4. **Community rating distributions** — per-show aggregate histograms (k≥5)
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

## 10. Phasing (v2.1 — resequenced after external review)

Both external reviewers made the same argument: a V1 that is only parity is a
"prettier Mezzanine," and the differentiators are the reason this feature
exists. Adopted — the identity modules move into V1; commodity stats move out.

- **V1 — priorities + identity:** hero tiles, shows per year, Broadway
  theater tracker (ring + checklist + house records), **You vs. the Critics /
  Audience**, **Tony & Canon checklists** (Best Musical/Play — needs
  `stats-canon.json` winners at V1), ratings histogram, scope pill (seasons +
  years; ceremony dates at V1), tap-through lists, **photo logging + Feed
  (timeline / photo wall)**. Pure `StatsEngine` struct over diary +
  `mobile-shows.json` (unit-tested reducers).
- **V1.1:** **Aisle Mates + Your Paper of Record** (`stats-reviews.json`
  artifact), People, Records & Superlatives (incl. total audience counter),
  Challenges + "what to see next," MapKit theater map (lat/lng artifact),
  share cards, optional log-sheet fields (price paid → spend stats;
  companions → private people tags).
- **V2:** Curtain Call both editions — **Season Finale ships first (June,
  post-Tonys)**, Year in Review follows (December) — plus community ghost
  overlay, The Mix earliness profile, milestone toasts ("that was show
  #200 🎉").

## 11. External review — GPT-5 & Gemini 2.5 Pro (2026-07-26)

Both models reviewed the full spec + mockup summary independently.

**Adopted (converging or clearly right):**
- **Resequenced phasing** (both): You vs. Critics + Tony checklists into V1;
  Records/Superlatives out to V1.1. "The V1 launch should scream what makes
  BroadwayScorecard unique, not just achieve parity" (Gemini).
- **Cut Habits & Streaks module** (Gemini; GPT implicitly): generic tracker
  fluff — its two good stats live in the Shows-per-year records strip.
- **Cut the third Feed view** (GPT): poster grid duplicates the profile Grid
  tab.
- **Scope-aware hero labels** (GPT): "This season so far" / "2026 YTD" —
  never mix season and calendar frames in one tile.
- **Hours-in-a-seat confidence rule** (GPT): demote the tile while >25% of
  entries use the runtime fallback.
- **App Store / photo-library checklist** (both): Limited Library support,
  purpose strings, export-&-delete-all, UGC review-notes defense, text-only
  feed as a first-class mode (§4).
- **Challenges / private lists with progress** (both, independently — GPT's
  "goals + what to see next," Gemini's people-graph energy): now §5.6, and it
  unifies canon shelves + theater checklist into one component.
- **Total audience counter** (Gemini), **critics-vs-audience divergence on
  your shows** (Gemini), **spend + companions as optional fields** (both) —
  folded into §5.5/§5.1/backlog→V1.1.
- **Ticket-link hygiene** (GPT): disclosure + consistent deeplink strategy.

**Considered, not adopted:**
- **Dropping season scoping from the pill** (Gemini): rejected — the owner
  explicitly wants the Tony-season frame first-class, and "seasons first,
  current season default" is one list, not a mode switch. Mitigation: GPT's
  scope-aware labels remove the ambiguity Gemini worried about.
- **People knowledge graph** (Gemini): great v3+ idea, heavy data/UX lift;
  parked.
- **Moving Feed IA out of the Profile tab** (GPT): the app's existing tab
  structure keeps Diary/Feed first-class already; revisit only if usage says
  the segmented control hides it.

## 12. Web parity (owner request, 2026-07-26)

The same stats features are wanted on broadwayscorecard.com. Principles:

- **One artifact set, two clients.** `stats-canon.json` and
  `stats-reviews.json` ship in `public/data/` (done 2026-07-26, generated by
  `scripts/generate-stats-canon.js` / `generate-stats-reviews.js` inside
  `generate-mobile-artifacts.sh`), so web fetches the exact files the app
  bundles. Diary ratings come from the same Supabase `reviews` table both
  clients already write to.
- **One engine, written once (plan-review 2026-07-26):** the stats reducers
  are written ONCE, in the web repo, as named pure functions in
  `src/lib/stats/` (`computeDiaryStats`, `seasonWindows`, `alignCritics` —
  no "StatsEngine" class; "engine" already means `src/lib/engine.ts`), with
  node:test coverage wired into test.yml. The app consumes a vendored build
  of that lib with a checksum drift test (the mobile-shows.json vendoring
  pattern) — NOT a second implementation with copied fixtures, because the
  app repo has no unit-test runner to keep copies honest.
- **Surface:** a stats view in the signed-in profile/diary area using the
  existing web design system only (web CLAUDE.md §4 components — ScoreBadge,
  cards, surface tokens). Same module order and thresholds as §2; scope pill
  included. Alignment computes client-side from the fetched artifacts —
  ratings never round-trip a server for this.
- **Phasing:** web V1 follows iOS V1 approval (same module cut), so screen
  decisions are made once on iOS and ported. Feed/photo parity on web is
  v1.1+ (same private bucket + owner-only RLS; a web upload UI is the only
  new surface).
