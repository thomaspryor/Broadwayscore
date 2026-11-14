---
name: TodayTix affiliate tracking — verified facts
description: TodayTix Impact affiliate terms, web-to-app tracking confirmed working via TrueLink, lottery/rush not excluded
type: feedback
originSessionId: ba2676a0-1232-4de7-b090-d7af31195aa2
archived: true
---
TodayTix affiliate tracking works in-app. Clicking a pxf.io affiliate link on a phone opens the TodayTix app directly (TrueLink deep linking is active). In-app purchases are attributed.

**Ad unit (as of 2026-04-22):** Universal App/Web Link `3855163` — `https://todaytix.pxf.io/c/6999278/3855163/20944?u={destUrl}`. Wired in `src/lib/affiliate-utils.ts:27`. Replaced older TrueLink ad `1774863` per TodayTix rep email 2026-04-21 recommending the new universal unit for full app+web attribution. Live redirect test confirmed both ads yield identical final URL + `irclickid` + `utm_*` params when `?u=` is passed; bare-URL difference is new ad → App Store (with `ct=Impact_Universal_Redirect&pt=2090379`), old ad → TodayTix homepage. Our code always passes `?u=`, so swap was behavior-neutral for all 380 deep-linked shows.

**Contract terms (Impact program 20944, current = template "5%/1%" 243224, signed Apr 7 2026):**
- **5% new customers, 1% existing** (bumped from 2%/1% on Apr 7 2026 — 2.5× on new-customer payouts)
- 14-day referral window (NOT 30 days)
- Last Click credit policy
- Action locking: 27 days after month end
- Payout scheduling: approved transactions paid 20 days after end of lock month
- Promo code blacklist: SV0, NOFEE, COMPTIX, TP, UPGRADE, 25PC, GC, PWY, SAVE, MAIL, EXCH
- No explicit exclusion of lottery or rush purchases
- 100% reversal policy (TodayTix can reverse any action)
- Media partner tracking pixel: NOT allowed
- Change notification period: 0 days
- Currency: USD
- Countersigned by Waverley Lyons (TodayTix Group)
- Contract PDF: ~/Library/Mobile Documents/com~apple~CloudDocs/TodayTix_TemplateTerms (4).pdf

**Why:** Earlier sessions speculated that app purchases wouldn't track because web cookies don't carry into apps. This was wrong — Impact's TrueLink opens the app directly from the affiliate redirect, preserving attribution without cookies. Confirmed by testing on phone: affiliate link opens TodayTix app.

**How to apply:** TodayTix affiliate links on lottery/rush are valid revenue sources, not just cookie-setters. Don't deprioritize TodayTix affiliate based on the false "web-only" assumption. Check Impact dashboard for actual conversion data to quantify revenue.
