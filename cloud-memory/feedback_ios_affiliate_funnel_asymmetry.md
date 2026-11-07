---
name: iOS affiliate funnel asymmetry — ticket_browser_dismissed only fires non-affiliate
description: PostHog funnel tap→opened→dismissed will appear to drop ~100% of TodayTix/Ticketmaster/StubHub/Vivid/SeatPlan traffic at the dismissed stage; this is by design, use Impact for affiliate conversions
type: feedback
originSessionId: 8f5a632b-3ee6-4eb9-a400-57a6c05c58df
archived: true
---
After the 2026-04-25 native-app-handoff fix (BroadwayScorecard-app commit a48b1ed), affiliate ticket clicks use `Linking.openURL(affiliateUrl)` instead of `WebBrowser.openBrowserAsync(affiliateUrl)`. **`Linking.openURL` has no dismiss callback** — iOS hands the URL to the system and our code returns immediately. So `ticket_browser_dismissed` only fires for non-affiliate clicks (Telecharge, official sites).

**Why:** The `Linking.openURL` path is what enables the iOS Universal Link → native TodayTix app handoff (Impact ad 3855163's "Universal App/Web Link" benefit). SFSafariViewController would suppress that handoff. There's no way to keep both the dismiss event and the native handoff — the dismiss callback is an SFSafariViewController feature, not a Linking one.

**How to apply:**
- If anyone rebuilds a `ticket_tap → ticket_browser_opened → ticket_browser_dismissed` PostHog funnel, **filter out `is_affiliate=true`** from the dismiss step or it will look like every TodayTix/Ticketmaster/StubHub/Vivid/SeatPlan user instantly bounced
- For affiliate platforms, **use Impact dashboard conversions** as the authoritative downstream signal instead of guessed time-on-site. We have `IMPACT_AUTH_TOKEN` + `IMPACT_ACCOUNT_SID` in `.env`; use `partner_performance_by_ad` report (CAMPAIGN_ID=20944 for TodayTix) — see scripts/lib/affiliate-stats.js for the existing query helper
- For non-affiliate platforms, time-on-site funnels still work — Telecharge/official sites still go through `WebBrowser.openBrowserAsync`
- Inline comment in `app/show/[slug].tsx` `openTicketLink` documents this; check there if the behavior surprises you

**Don't "fix" by routing affiliate clicks through WebBrowser.openBrowserAsync** to recover the dismiss event — that re-introduces the SFSafariViewController Universal-Link suppression bug. The asymmetry is the correct trade-off.
