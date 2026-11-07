---
name: Affiliate infrastructure patterns
description: "TicketLink Impact/Partnerize/UTM; sorting in shared module not 'use client'."
type: feedback
archived: true
---

Affiliate config lives in TicketLink.tsx (AFFILIATE_CONFIG) with three network types: impact, partnerize, utm. Sorting in ticket-utils.ts (shared module, NOT in 'use client' component — SSR broke when it was in TicketLink.tsx).

**Why:** Server components can't import from 'use client' modules at build time — causes "(0 , f.hp) is not a function" during prerendering.

**How to apply:** When adding new affiliate platforms: (1) add to AFFILIATE_CONFIG with enabled: false, (2) add platform to TICKET_PLATFORM_PRIORITY in ticket-utils.ts, (3) fill in credentials and set enabled: true when approved. Amber accent (bg-amber-500/15 + text-amber-300 + border-amber-500/30) appears automatically for enabled platforms via isAffiliate check in TicketLink component.

**Impact URL format:** `https://{domain}/c/{publisherId}/{campaignId}/{programId}?u={encodedUrl}` — NOT the `/click/camref:` format from Impact docs. Publisher ID 6999278 is shared across all Impact campaigns.

**PostHog custom events via sendBeacon:** PostHog SDK capture() batches events on a 30s timer and flushes on beforeunload. With target="_blank" links, neither fires reliably. Must use navigator.sendBeacon() directly to PostHog capture API (`https://us.i.posthog.com/capture/`) with api_key in the payload. The SDK's flush() method doesn't exist in the minified build.

**RSC serialization gotcha:** When passing show data from server components to client components (BrowseListClient, ShowListCard), you must explicitly include ticketLinks in the serialized object. TypeScript strips unlisted fields — adding to the interface alone doesn't make the data flow through.

**StubHub SERP gotcha:** Hamilton matched John Mulaney's StubHub page. Short/common titles need URL-slug cross-checking. StubHub uses both /performer/ (persistent) and /category/ pages — both are valid. /event/ pages expire. Regional subdomains (/cl/, /za/) must be stripped.

**Linter race condition:** The dev environment has a save hook that can revert uncommitted changes. When making multiple file edits, commit atomically (Python script or single git add+commit) to prevent the linter from reverting intermediate states.
