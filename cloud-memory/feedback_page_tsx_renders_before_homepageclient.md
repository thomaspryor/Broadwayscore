---
name: page-tsx-renders-before-homepageclient
description: "Above-the-fold features must live in src/app/page.tsx, not src/components/HomePageClient.tsx — page.tsx server-renders shelves (FeaturedRowServer, hero) BEFORE the HomePageClient subtree"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: deaaaaf0-407e-4687-a40b-2de238c713ef
---

When adding a feature that should appear above (or between) the SSR-rendered homepage shelves (`<FeaturedRowServer>`, hero text), put the JSX in `src/app/page.tsx` — NOT in `src/components/HomePageClient.tsx`.

**Why:** `src/app/page.tsx` renders the hero block and `<FeaturedRowServer shows={bestRecentShows} />` server-side inside its outer `<div>`, then mounts `<HomePageClient skipHero skipFirstMusicals>` as a sibling AFTER that. Source-order placement inside HomePageClient's JSX renders BELOW the SSR shelves, not above. Caught 2026-05-25 building the above-fold FeaturedSpotSlim — first wired it in HomePageClient, slim card rendered after "Best Recent Shows" instead of before. Moving the render block to page.tsx (above the FeaturedRowServer call) fixed it.

**How to apply:**
- Anything that needs to appear above or between the SSR shelves → render in `src/app/page.tsx`.
- Anything below the SSR shelves (search bar, filters, full show list, mid-page featured rows, email capture) → HomePageClient is correct.
- Visual check: scroll-position test on the rendered page tells the truth — source-order in the client component is misleading because HomePageClient mounts as a sibling of the SSR block, not a wrapper.

See `[[design-system]]` for the broader homepage layout.
