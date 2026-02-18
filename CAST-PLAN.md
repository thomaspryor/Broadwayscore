# Cast List Feature — Implementation Plan

## Overview
Add Broadway cast lists to show pages, with actor profile pages. Two phases:
- **Phase 1:** OBC data backfill from IBDB + display on show pages
- **Phase 2:** Actor profile pages (`/actors/[slug]`) with search index

## Data Source: IBDB (Internet Broadway Database)
Each IBDB production page has four HTML tabs:
- `#OpeningNightCast` — Full OBC with roles
- `#CurrentCast` — Who's performing now
- `#Replacements` — Every replacement with exact date ranges
- `#ProductionStaff` — Creative team (already scraped)

No anti-bot protection. Already integrated via `ibdb-dates.js`. ScrapingBee fetches cleanly.

---

## Phase 1: OBC Data

### S1-T0: Define cast data schema and storage
- Per-show cast files at `data/cast/{show-id}.json`:
  ```json
  {
    "showId": "hamilton-2015",
    "ibdbUrl": "https://ibdb.com/...",
    "scrapedAt": "2026-02-18T...",
    "openingNightCast": [
      {"name": "Lin-Manuel Miranda", "role": "Alexander Hamilton", "ibdbPersonId": "123456", "flags": ["Broadway debut"]},
      {"name": "Leslie Odom Jr.", "role": "Aaron Burr"}
    ],
    "currentCast": null
  }
  ```
- Add TypeScript interface in `data-types.ts`
- Create `data-cast-obc.ts` module that reads all `data/cast/*.json` at build time and provides `getShowCast(showId)`
- Migration policy for 46 existing shows: IBDB data wins (overwrite), log conflicts
- VERIFY: Interface compiles, module loads with empty directory

### S1-T1: Create `ibdb-cast.js` scraper module
- New `scripts/lib/ibdb-cast.js` that reuses IBDB URL discovery from `ibdb-dates.js`
- Parses `#OpeningNightCast` tab: actor name, role, IBDB person ID (from href), status flags
- Returns structured array matching the schema from S1-T0
- Handles gracefully: no IBDB page found, empty cast tab, unusual HTML on old shows
- VERIFY: Run against Hamilton (large modern cast), Death of a Salesman 1949 (old show), a show with no IBDB page. Compare output against manually verified IBDB data.

### S1-T2: Create backfill script
- `scripts/backfill-cast.js`:
  1. Reads `shows.json` for the show list
  2. For each show, calls `ibdb-cast.js` to get OBC
  3. Writes to `data/cast/{show-id}.json` (one file per show — no merge conflicts)
  4. Each file is its own checkpoint (idempotent)
- Supports `--shard N --total-shards M` and `--show-filter SHOW_ID`
- Skips shows that already have a `data/cast/{show-id}.json` file
- VERIFY: Run for 5 shows, verify 5 JSON files created with correct structure

### S1-T3: Create GitHub Action workflow for backfill
- `backfill-cast.yml` with manual dispatch, shard inputs
- Commits `data/cast/*.json` files (not shows.json — no merge conflicts between shards)
- Runs `node scripts/validate-data.js` before committing
- `if: always()` on commit/push, 5-retry push with `--rebase -X theirs`
- VERIFY: Run shard 1/10, verify ~73 new JSON files committed

### S1-T4: Display OBC on show pages + integrate
- New `CastSection` component in `src/components/`
- "Original Broadway Cast" header, actor name + role rows
- Shows first 8, expand/collapse for the rest
- Add to `show/[slug]/page.tsx`, below creative team section
- Uses `getShowCast(show.id)` from `data-cast-obc.ts`
- Gate behind feature flag initially
- Don't render if no cast data exists
- VERIFY: Build succeeds. Check Hamilton (large cast), a small play, a show with no cast file

### S1-T5: Add cast validation to validate-data.js
- Validate each `data/cast/{show-id}.json`: required fields, showId matches filename, no empty names
- Warn on >60 cast members (likely parsing error)
- Warn on 0 cast members in file (empty array)
- VERIFY: Run validator, no errors on backfilled data

---

## Phase 1b: Current Cast (weekly for open shows)

### S1b-T1: Extend `ibdb-cast.js` for Current Cast tab
- Parse `#CurrentCast` tab, write `currentCast` array into same `data/cast/{show-id}.json`
- VERIFY: Run for 3 open shows, compare against Playbill.com current cast (external source)

### S1b-T2: Create current-cast update script
- `scripts/update-current-cast.js`
- For each open show, scrape IBDB Current Cast, update `data/cast/{show-id}.json`
- Add `currentCastUpdatedAt` timestamp
- VERIFY: Run for 3 open shows, verify JSON files updated

### S1b-T3: Add "Now Playing" section to CastSection
- Below OBC, show "Now Playing (updated [date])" for open shows with currentCast data
- Same expand/collapse pattern
- VERIFY: Open show page with current cast data renders both sections

### S1b-T4: Add to weekly automation
- Workflow for weekly current-cast updates on open shows
- Runs `validate-data.js` before commit
- VERIFY: Workflow runs, commits updated files, build succeeds

---

## Phase 2: Actor Profile Pages

### S2-T0: Pre-generate `data/actors.json` during backfill
- Consolidation script runs after all cast files are written
- Reads all `data/cast/{show-id}.json`, deduplicates by IBDB person ID (primary) with name-normalization fallback (lowercase, trim, collapse whitespace)
- Builds profiles with show lists + scores
- Writes single `data/actors.json`
- Build reads ONE file, not 728
- VERIFY: File under 10 MB. Actor count 5,000-15,000. Spot-check 5 actors.

### S2-T1: Add TypeScript types + feature flag
- Add `ActorProfile` and `ActorShowEntry` interfaces to `data-types.ts`
- Add `actorPages` to `feature-flags.ts`
- VERIFY: TypeScript compiles

### S2-T2: Create `data-actors.ts` module
- Reads `data/actors.json` at module load (single file, lazy-init)
- Provides: `getActorProfile(slug)`, `getAllActorProfiles()`, `getAllActorSlugs()`, `getActorSlugForName(name)`
- Slug collision handling
- VERIFY: Module loads, slug count matches expected, spot-check profiles

### S2-T3: Create `/actors/[slug]` page
- Follow `/creative/[slug]` pattern: static params, metadata, breadcrumbs, JSON-LD
- Actor name, show count, avg critic score header
- Show list: thumbnail, title, role(s), score badge, venue, dates
- Gate behind `actorPages` feature flag
- VERIFY: Build succeeds. Check multi-show actor, single-show actor, nonexistent slug (404)

### S2-T4: Create `/actors` index page
- Client-side search bar + alphabetical letter filter
- Lightweight JSON (name, slug, showCount, avgScore only)
- Top 50 most prolific by default, search reveals rest
- VERIFY: Page loads <2s. Search works. Build time increase <30s.

### S2-T5: Make cast names clickable on show pages
- Link names to `/actors/[slug]` from CastSection
- Only link if profile exists, plain text otherwise
- VERIFY: Hamilton cast has clickable links. Unknown ensemble actor is plain text.

### S2-T6: Build time verification gate
- Full build with all actor pages enabled
- Measure: total build time, peak memory, page count
- Threshold: build time >10 min or pages >15,000 → investigate
- VERIFY: Build completes within Vercel limits

---

## Phase 3 (future): Cross-linking + Enhancements
- Cross-link actor ↔ creative pages via IBDB person IDs
- Actor headshots (from IBDB or Playbill)
- "Trending cast changes" on homepage
