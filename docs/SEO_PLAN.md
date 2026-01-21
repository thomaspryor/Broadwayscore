# Broadway Metascore: SEO & Discovery Master Plan

## Current State (Phase 1 Complete)

### Implemented
- [x] Dynamic BASE_URL using environment variable
- [x] Canonical URLs on all pages via Next.js metadata API
- [x] Enhanced meta titles with scores for better CTR
- [x] OpenGraph and Twitter card optimization
- [x] Sitemap.xml with smart prioritization
- [x] Robots.txt properly configured
- [x] JSON-LD TheaterEvent schema with AggregateRating

---

## Phase 2: Rich Structured Data

### 2.1 BreadcrumbList Schema
**Impact:** Enables breadcrumb rich snippets in Google
```
Home > Shows > [Show Title]
Home > Directors > [Director Name]
Home > Theaters > [Theater Name]
```

### 2.2 Review Schema (Individual Critics)
**Impact:** Enables star ratings and review snippets in search results
- Add `Review` schema for each critic review
- Include: reviewer name, publication, rating, review excerpt
- Links to existing `AggregateRating`

### 2.3 Organization Schema
**Impact:** Establishes site identity in Knowledge Graph
- BroadwayMetaScores as `Organization`
- Logo, URL, social profiles

### 2.4 Offer/Ticket Schema
**Impact:** Enables "Get Tickets" rich results
- `Offer` schema with ticket pricing
- Link to TodayTix, Telecharge, etc.
- Show price ranges and availability

### 2.5 Person Schema (for Directors, Cast)
**Impact:** Entity linking for people pages
- Directors with `Person` schema
- Cast members with roles

---

## Phase 3: Content Expansion (SEO Traffic Magnets)

### 3.1 Top Lists Pages (High Priority)
New pages targeting "best broadway" searches:

| URL | Title | Target Keywords |
|-----|-------|-----------------|
| `/best/musicals` | Best Broadway Musicals 2026 | "best broadway musicals", "top musicals nyc" |
| `/best/plays` | Best Broadway Plays 2026 | "best broadway plays", "top plays nyc" |
| `/best/new-shows` | Best New Broadway Shows | "new broadway shows", "what to see on broadway" |
| `/best/reviewed` | Top 10 Highest Rated Shows | "highest rated broadway shows" |
| `/best/family` | Best Broadway Shows for Families | "broadway shows for kids", "family broadway" |

**Implementation:**
- Auto-generated from shows.json data
- Filter by type, status, tags, scores
- Updated dynamically as scores change

### 3.2 Director Pages (Medium Priority)
Individual pages for each director showing all their shows:

| URL | Content |
|-----|---------|
| `/director/[slug]` | All shows by director, avg score, timeline |

**Features:**
- List all shows directed by person
- Average score across their shows
- Career timeline
- Links to individual show pages

**Example:** `/director/marianne-elliott`
- Shows: Company, War Horse, The Curious Incident...
- Average Score: 82
- Timeline visualization

### 3.3 Theater/Venue Pages (Medium Priority)
Individual pages for each Broadway theater:

| URL | Content |
|-----|---------|
| `/theater/[slug]` | Current show, history, location info |

**Features:**
- Current show playing
- Past shows at venue (with scores)
- Theater capacity, address, accessibility
- Google Maps integration
- "Shows at [Theater]" search capture

**Example:** `/theater/shubert-theatre`
- Current: Some Like It Hot
- Past: To Kill a Mockingbird (89), Company (85)...
- Address, map, accessibility info

### 3.4 Comparison Pages (Future)
Head-to-head show comparisons:

| URL | Content |
|-----|---------|
| `/compare/[show1]-vs-[show2]` | Side-by-side comparison |

**Features:**
- Score comparison
- Review highlights from each
- Ticket price comparison
- "Which should I see?" verdict

### 3.5 Critic/Publication Pages (Future)
Pages for major publications:

| URL | Content |
|-----|---------|
| `/critic/new-york-times` | All NYT reviews, their avg rating |
| `/critic/vulture` | All Vulture reviews |

---

## Phase 4: Technical SEO Enhancements

### 4.1 Image Optimization
- [ ] Add descriptive alt text: `"${show.title} Broadway ${show.type} poster at ${show.venue}"`
- [ ] Add width/height attributes to prevent CLS
- [ ] Add loading="lazy" for below-fold images

### 4.2 Internal Linking
- [ ] Related shows section on each show page
- [ ] "Also by this director" links
- [ ] "Also at this theater" links
- [ ] Cross-link between best-of lists

### 4.3 URL Structure
Current: Clean and SEO-friendly
```
/                          # Homepage
/show/[slug]               # Show pages
/methodology               # How it works
```

Proposed additions:
```
/best/[category]           # Best-of lists
/director/[slug]           # Director pages
/theater/[slug]            # Theater pages
/compare/[show1]-vs-[show2] # Comparisons
```

---

## Phase 5: Discovery & Indexing

### 5.1 Search Console Setup
- [ ] Verify site ownership
- [ ] Submit sitemap.xml
- [ ] Monitor indexing status
- [ ] Track search queries

### 5.2 Social Sharing
- [ ] Auto-post score updates to Twitter
- [ ] Share new show additions
- [ ] Embeddable score widgets for blogs

### 5.3 Schema Testing
- [ ] Test all structured data in Google's Rich Results Test
- [ ] Validate JSON-LD with Schema.org validator

---

## Implementation Priority

### Immediate (This Sprint)
1. **Phase 2.1-2.2** - BreadcrumbList + Review schemas
2. **Phase 3.1** - Top 10 / Best-of list pages

### Next Sprint
3. **Phase 3.2** - Director pages
4. **Phase 3.3** - Theater pages
5. **Phase 4.1** - Image alt text improvements

### Future
6. **Phase 3.4** - Comparison pages
7. **Phase 3.5** - Critic pages
8. **Phase 5** - External discovery

---

## Data Requirements

### For Director Pages
Need to extract unique directors from `creativeTeam` in shows.json:
```typescript
// Example query
const directors = shows
  .flatMap(s => s.creativeTeam?.filter(m => m.role === 'Director'))
  .reduce((acc, d) => {
    acc[d.name] = acc[d.name] || [];
    acc[d.name].push(show);
    return acc;
  }, {});
```

### For Theater Pages
Already have `venue` and `theaterAddress` in shows.json.
Need to create theater slugs and aggregate historical data.

### For Best-of Pages
Already have: `type`, `status`, `tags`, `criticScore.score`
Can generate all lists dynamically.

---

## Success Metrics

| Metric | Target | Timeline |
|--------|--------|----------|
| Pages indexed | 100% of shows | 2 weeks |
| Rich results | Review stars in SERPs | 4 weeks |
| Organic traffic | 500 visits/month | 8 weeks |
| Keyword rankings | Top 10 for "[show] reviews" | 8 weeks |

---

## File Changes Required

### New Files
```
src/app/best/[category]/page.tsx    # Best-of list pages
src/app/director/[slug]/page.tsx    # Director pages
src/app/theater/[slug]/page.tsx     # Theater pages
src/lib/seo.ts                      # SEO utilities (schemas, etc.)
```

### Modified Files
```
src/app/show/[slug]/page.tsx        # Add BreadcrumbList, Review schemas
src/app/sitemap.ts                  # Add new page types
src/lib/data.ts                     # Add director/theater queries
```

---

## Notes

- All new pages should be statically generated at build time
- Use `generateStaticParams()` for dynamic routes
- Keep page weight low - no heavy JS for content pages
- Prioritize mobile experience (Google's mobile-first indexing)
