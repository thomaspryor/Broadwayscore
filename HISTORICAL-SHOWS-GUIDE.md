# Historical Shows Guide

**Created:** January 29, 2026
**Status:** In Progress - Documenting gaps and solutions

---

## The Problem

When expanding to historical Broadway seasons (going back 20+ years), we face several challenges:

1. **Revivals vs Originals** - "Cabaret" has had multiple Broadway productions (1966, 1998, 2014, 2024)
2. **Tours vs Broadway** - Tours sometimes have similar names but aren't Broadway productions
3. **Venue Confusion** - Same show might play different theaters in different productions
4. **Season Boundaries** - Broadway seasons span July 1 - June 30 (not calendar years)
5. **Data Quality** - Older productions may have incomplete or conflicting data

---

## Current State (What We Have)

### Show ID Schema
- Pattern: `{slug}-{opening-year}` (e.g., `cabaret-2024`, `hamilton-2015`)
- Works well for distinguishing productions
- Problem: What if a show opens in December 2024 but is in the 2024-2025 season?

### Deduplication (`scripts/lib/deduplication.js`)
- Prevents adding "SIX" when we have "SIX: The Musical"
- 75+ known title variations mapped
- **Gap:** Doesn't distinguish revivals - treats all "Cabaret" as duplicates

### Revival Detection (`scripts/lib/known-shows.js`)
- Lists ~100 classic musicals and plays
- Flags when a discovered show matches a classic
- **Gap:** Doesn't link revivals to originals in the data

### Venue List
- 46 venues in database (with inconsistencies)
- "Hayes Theater" vs "Helen Hayes Theatre" vs "Helen Hayes Theater"
- **Gap:** No canonical Broadway theater list for validation

---

## Gaps to Fix

### 1. Broadway Season Definitions

Broadway seasons run **July 1 through June 30**:
- 2024-2025 season: July 1, 2024 - June 30, 2025
- Tony eligibility cutoff: Usually late April

**Needed:**
```javascript
// scripts/lib/broadway-seasons.js
function getSeasonForDate(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed

  // July-December = first year of season
  // January-June = second year of season
  if (month >= 6) { // July onwards
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

// Examples:
// getSeasonForDate('2024-08-15') → '2024-2025'
// getSeasonForDate('2025-03-10') → '2024-2025'
// getSeasonForDate('2025-07-01') → '2025-2026'
```

### 2. Broadway Theater Canonical List

The **41 official Broadway theaters** (500+ seats in Theater District):

```javascript
// scripts/lib/broadway-theaters.js
const BROADWAY_THEATERS = {
  // Shubert Organization (17 theaters)
  'ambassador': { canonical: 'Ambassador Theatre', seats: 1125 },
  'booth': { canonical: 'Booth Theatre', seats: 785 },
  'broadhurst': { canonical: 'Broadhurst Theatre', seats: 1186 },
  'cort': { canonical: 'James Earl Jones Theatre', seats: 1084, aliases: ['Cort Theatre'] },
  'imperial': { canonical: 'Imperial Theatre', seats: 1417 },
  // ... etc

  // Nederlander Organization (9 theaters)
  'brooks-atkinson': { canonical: 'Brooks Atkinson Theatre', seats: 1069 },
  'gershwin': { canonical: 'Gershwin Theatre', seats: 1933 },
  // ... etc

  // Jujamcyn (5 theaters)
  'august-wilson': { canonical: 'August Wilson Theatre', seats: 1222 },
  'eugene-oneill': { canonical: "Eugene O'Neill Theatre", seats: 1108 },
  // ... etc

  // Others
  'studio-54': { canonical: 'Studio 54', seats: 1006 },
  'circle-in-the-square': { canonical: 'Circle in the Square Theatre', seats: 776 },
  // ... etc
};

function isOfficialBroadwayTheater(venueName) {
  const normalized = normalizeVenueName(venueName);
  return BROADWAY_THEATERS[normalized] !== undefined;
}

function normalizeVenueName(name) {
  return name
    .toLowerCase()
    .replace(/theatre/g, 'theater')
    .replace(/\s+theater$/i, '')
    .replace(/['']/g, '')
    .trim();
}
```

### 3. Tour Detection

Tours should NEVER be added to our database:

```javascript
// scripts/lib/tour-detection.js

const TOUR_INDICATORS = [
  /national tour/i,
  /touring production/i,
  /first national/i,
  /north american tour/i,
  /\btour\b/i,
  /on tour/i,
  /touring company/i,
];

const NON_BROADWAY_VENUES = [
  // Major touring venues that are NOT Broadway
  'ahmanson theatre',      // LA
  'pantages theatre',      // LA/Hollywood
  'curran theatre',        // San Francisco
  'orpheum theatre',       // SF/LA/Minneapolis
  'kennedy center',        // DC
  'national theatre',      // DC
  'cadillac palace',       // Chicago
  'privatebank theatre',   // Chicago
  'fox theatre',           // Atlanta/Detroit
  'saenger theatre',       // New Orleans
  'bass performance hall', // Fort Worth
  'smith center',          // Las Vegas
];

function isTourProduction(show) {
  // Check title
  for (const pattern of TOUR_INDICATORS) {
    if (pattern.test(show.title)) {
      return { isTour: true, reason: 'Title contains tour indicator' };
    }
  }

  // Check venue
  const venueNormalized = show.venue?.toLowerCase() || '';
  for (const tourVenue of NON_BROADWAY_VENUES) {
    if (venueNormalized.includes(tourVenue)) {
      return { isTour: true, reason: `Venue "${show.venue}" is a touring venue` };
    }
  }

  // Check if venue is NOT in Broadway theater list
  if (show.venue && !isOfficialBroadwayTheater(show.venue)) {
    return { isTour: true, reason: `Venue "${show.venue}" is not an official Broadway theater` };
  }

  return { isTour: false };
}
```

### 4. Revival Schema Extension

Add revival metadata to shows.json:

```json
{
  "id": "cabaret-2024",
  "title": "Cabaret at the Kit Kat Club",
  "isRevival": true,
  "originalProductionId": "cabaret-1966",
  "productionNumber": 4,
  "revivals": ["cabaret-1998", "cabaret-2014", "cabaret-2024"],
  "productionHistory": {
    "original": { "id": "cabaret-1966", "openingDate": "1966-11-20" },
    "revivals": [
      { "id": "cabaret-1998", "openingDate": "1998-03-19" },
      { "id": "cabaret-2014", "openingDate": "2014-04-24" },
      { "id": "cabaret-2024", "openingDate": "2024-04-21" }
    ]
  }
}
```

### 5. Historical Discovery Workflow Updates

Update `discover-historical-shows.js`:

```javascript
async function processDiscoveredShow(show, existingShows) {
  // 1. Tour check (REJECT if tour)
  const tourCheck = isTourProduction(show);
  if (tourCheck.isTour) {
    return { action: 'reject', reason: tourCheck.reason };
  }

  // 2. Broadway theater check (WARN if unknown venue)
  if (!isOfficialBroadwayTheater(show.venue)) {
    console.warn(`⚠️  Unknown venue: ${show.venue} - may not be Broadway`);
  }

  // 3. Revival check
  const knownCheck = checkKnownShow(show.title);
  if (knownCheck.isKnown) {
    // Find existing productions of this show
    const existingProductions = findExistingProductions(show.title, existingShows);

    if (existingProductions.length > 0) {
      // This is a revival - link to original
      show.isRevival = true;
      show.originalProductionId = existingProductions[0].id;
      show.productionNumber = existingProductions.length + 1;
    } else {
      // First production we're adding - could be original or first revival we track
      show.isRevival = false; // Will need manual verification for very old shows
    }
  }

  // 4. Season validation
  const season = getSeasonForDate(show.openingDate);
  if (season !== show.season) {
    console.warn(`⚠️  Season mismatch: show has ${show.season} but date suggests ${season}`);
  }

  return { action: 'add', show };
}
```

---

## Implementation Plan

### Phase 1: Foundation (Before Historical Expansion)
1. [ ] Create `scripts/lib/broadway-theaters.js` with canonical list
2. [ ] Create `scripts/lib/tour-detection.js`
3. [ ] Create `scripts/lib/broadway-seasons.js`
4. [ ] Add venue normalization (like we have for outlets)
5. [ ] Fix existing venue inconsistencies in shows.json

### Phase 2: Schema Updates
1. [ ] Add `isRevival`, `originalProductionId` fields to show schema
2. [ ] Add `productionHistory` for shows with multiple productions
3. [ ] Update TypeScript types in `src/lib/engine.ts`

### Phase 3: Discovery Updates
1. [ ] Update `discover-historical-shows.js` with new validations
2. [ ] Add tour rejection logic
3. [ ] Add revival linking logic
4. [ ] Add Broadway theater validation

### Phase 4: Review Data Linking
1. [ ] When gathering reviews for revivals, verify reviews match the production year
2. [ ] Flag reviews that might be for wrong production (e.g., 2024 review on 1998 show)
3. [ ] Add `productionId` to review files for explicit linking

---

## Edge Cases to Handle

### 1. Long-Running Shows
- "The Phantom of the Opera" (1988-2023) - One production, 35 years
- "Chicago" (1996-present) - Revival, running 28+ years
- These should have ONE entry, not annual entries

### 2. Return Engagements
- "Fiddler on the Roof" closed, then returned - same production or new?
- Generally treat as same production if cast/creative team similar

### 3. Name Changes
- "Cort Theatre" → "James Earl Jones Theatre" (2022)
- Keep aliases, use canonical name

### 4. Venue Moves
- Show moves from one theater to another mid-run
- Keep original theater, note move in metadata

### 5. Transfer from Off-Broadway
- "Little Shop of Horrors" - multiple Broadway transfers
- Each Broadway run is a separate production

---

## Validation Checklist (Before Adding Any Historical Show)

- [ ] Is this a Broadway production (not tour, not Off-Broadway)?
- [ ] Is the venue an official Broadway theater?
- [ ] What production number is this? (original, 1st revival, etc.)
- [ ] Does opening date match the stated season?
- [ ] If revival, is original production in database? Should it be?
- [ ] Are we sure reviews we'll gather are for THIS production?

---

## Questions to Resolve

1. **How far back do we go?**
   - 2000? 1990? 1980?
   - Older shows have less review data online

2. **Do we add original productions retroactively?**
   - If we have Cabaret 2024, should we add Cabaret 1966?
   - Probably yes for context, but reviews may be unavailable

3. **How to handle shows we track that close then return?**
   - "Aladdin" closed 2024, will likely return - same ID or new?
