# Sprint Plan: AdSense Launch (low-effort, low-clutter ads), revised after /plan-review

## Overview
Add Google AdSense to broadwayscorecard.com (which also serves West End Scorecard at `/west-end`): one fixed-size, clearly labeled ad on show pages, no pop-ups, sticky ads, video or Auto ads, no ads for signed-in members, and no ads for visitors in the UK, EEA or Switzerland (so no cookie-consent pop-up for anyone). The work ramps in three phases:
- **Phase A:** a tiny change that gets the site approved by Google.
- **Phase B:** one ad slot behind a single runtime PostHog flag that is both the kill switch and a 50/50 test.
- **Phase C:** optional extras, only if the test says ads are worth keeping.

Agents (Claude or Codex) do all code work. The owner spends about 45 minutes in total in the AdSense and Vercel dashboards.

**Expected revenue:** about $30–115/month with one ad on show pages, after leaving out UK/EEA/CH visitors (~15% of real pageviews, at lower ad rates than the US) [CHANGED: owner decision 2026-10-22, no ads for UK/EEA/CH] at today's ~56k real pageviews a month (bot-filtered PostHog, 30 days to Oct 19, 2026; ~90% of human traffic is US/UK/CA/AU/NZ/IE). This drops by about half during the 4-week 50/50 test. It is a planning estimate, not a quote. If Vercel needs an upgrade to Pro ($20/month), that cost comes out of it. [CHANGED: subtract Pro cost; structure reviewer]

**Decision metric (owner-agreed):** total revenue per 1,000 real pageviews (AdSense + TodayTix/Impact commission, minus any Vercel Pro upgrade), ads group vs no-ads group, alongside ticket-click rate.

## Review status
`/plan-review` ran 2026-10-22 with six reviewers:
- Codex lens: the Codex CLI was missing in the cloud container, so it fell back to the OpenAI API without codebase access. The output guard flagged that review as "refused", but it was a full critique, so it was used.
- Gemini: ran; it has no codebase access.
- Four Claude reviewers: structure, pre-mortem, user impact and code design. These ran as general-purpose agents because the `review-panelist` type was unavailable.

The review found one P0 (our own automation would generate invalid ad traffic) and a restructure finding (request Google review before building any ad code). Both are folded in below. The original plan is in git history (commit 08e79e4c).

## Owner Checklist (the only manual work)

| When | What | Time |
|---|---|---|
| **Step 0, now** | (a) Check the Vercel team "thomaspryor's projects" is on **Pro**, not Hobby. Vercel's fair-use rules ban commercial use on Hobby and name AdSense explicitly. If it's Hobby, upgrading costs $20/month; decide whether that's worth it before continuing. (b) Sign up at adsense.google.com, add `broadwayscorecard.com` and send the agent your publisher ID (`ca-pub-…`). It is public, not a secret. | 15 min |
| **Step 1, after Phase A is live** | In AdSense → Sites, click **Request review**. Approval usually takes days to a couple of weeks. | 2 min |
| **Step 2, after approval** | Follow the B-T1 runbook: create one 300×250 display unit, turn off every Auto ads format and Google's optimization experiments, turn on the consent messages, paste the blocklist, and preview the UK consent message. | 20 min |
| **Step 3, at launch** | Reply "go". The agent sets the PostHog `ads` flag to 50/50 (B-T7). | 1 min |
| **Step 4, week 4** | Read the one-page result (B-T8) and choose: roll ads to 100%, pull them (0%), or run longer. | 10 min |

## Phase Summary

| Phase | Goal | Tasks | Complexity |
|---|---|---|---|
| A | Approval-ready site; no ad code | 2 | 2S |
| B | One show-page slot behind the runtime `ads` flag, UK/EEA/CH region gate, automation opt-out, 50/50 test, readout | 9 | 5S, 3M, 1L |
| C | Optional, only if Phase B says keep: browse-list slot, weekly ad-revenue line | 2 | 2M |

Total: **11 required tasks** (A+B), down from 18. Phase A is about one hour of agent work. Phase B is one session after approval. Phase C is optional. [CHANGED: scope cut from 18 tasks/4 sprints; ramp restructured; structure reviewer, external GPT reviewer, design reviewer, Phase 0]

**Who can run what:** Phases A and B code suit either a Claude cloud session (lands via `land/bro-N-<slug>`) or a Codex task (edit in place, then the owner's "Create PR"; the branch must be `codex/<slug>` if one is created). B-T6 (firewall) and B-T7 (flag rollout) need the Vercel and PostHog connectors, so they suit a Claude session. Every phase gets a Linear issue (CLAUDE.md §6).

---

## Phase A: Approval-ready site (no ad code)
**Demo:** `curl https://broadwayscorecard.com/ads.txt` returns the Google line. The homepage `<head>` has the `google-adsense-account` meta tag. `/privacy` mentions advertising. No ad code exists anywhere.
**Depends on:** Owner Step 0.
**Why this is first:** Google approval is the riskiest assumption (data-heavy sites can be rejected as "low value content"). Request review before building anything that only matters if Google says yes. [CHANGED: review requested before any ad code is written; structure reviewer, Phase 0]

### Task A-T1: ads.txt route + verification meta tag
- **Complexity:** S
- **Depends on:** Owner Step 0
- **Files:** `src/lib/ads.ts` (new; holds only `ADSENSE_CLIENT` for now), `src/app/ads.txt/route.ts` (new), `src/app/layout.tsx` (modify the `metadata` export)
- **Description:**
  - `ADSENSE_CLIENT` is the committed `ca-pub-…` string.
  - The `ads.txt` route mirrors `src/app/llms.txt/route.ts`. It returns `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0` as `text/plain`, with `pub-…` derived by stripping `ca-` from `ADSENSE_CLIENT`.
  - Add `other: { 'google-adsense-account': ADSENSE_CLIENT }` to the root metadata.
  - Both are unconditional: the ID is committed, so there is no empty case to handle. [CHANGED: removed the empty-ID branch, since the constant never changes at runtime; design reviewer, external GPT reviewer]
  - **Demo host:** in the route and the meta tag, skip output when the request host is `demo.broadwayscorecard.com`, so the demo site never claims the publisher account. [CHANGED: demo host; coordinator conflict check]
- **Acceptance criteria:**
  - VERIFY: after deploy, `curl -s https://broadwayscorecard.com/ads.txt` prints exactly one Google line
  - VERIFY: `curl -s https://broadwayscorecard.com/ | grep -c 'google-adsense-account'` returns 1

### Task A-T2: Privacy policy wording
- **Complexity:** S
- **Depends on:** None
- **Files:** `src/app/privacy/page.tsx`
- **Description:**
  - Replace the sentence at ~line 152 ("We don't show third-party ads…"). Google's review looks at the site as-is, and the sentence would be false once ads run.
  - Use wording that is true **before and after** launch [CHANGED: no claims that are false during the review window; user-impact reviewer]: "We may show ads from Google AdSense on some pages. If we do, Google and its partners may use cookies or device identifiers to serve and measure ads. We don't show ads to visitors in the UK, the EEA or Switzerland. US visitors can opt out of personalized ads. Signed-in members don't see ads."
  - Link to Google's "How Google uses information from sites or apps that use our services" page and to the ad personalization settings.
  - Add AdSense to "Services We Use" (~159–171) and bump "Last updated" (line 31). Leave the Impact affiliate wording alone.
- **Acceptance criteria:**
  - VERIFY: `grep -c "don&apos;t show third-party ads" src/app/privacy/page.tsx` returns 0
  - VERIFY: `/visual-qa` passes on `/privacy`

**Phase A ship:** CLAUDE.md §12 checks, land, then `node scripts/check-prod-deploy.js HEAD --wait`. Then tell the owner to do Step 1. **Do not start Phase B until Google approves.**

Removed from the original Sprint 1:
- **CSP edits:** the policy is report-only, so nothing breaks without them. They move to the Phase B edge cases.
- **robots.txt explicit allow:** `*` already allows the AdSense crawler.

[CHANGED: dropped from the pre-approval path; external GPT reviewer, structure reviewer]

---

## Phase B: One show-page ad, runtime flag, 50/50 test
**Demo:** With the PostHog flag `ads` forced to `ads` for your own browser, a logged-out show page shows one labeled 300×250 ad below the critic reviews. With the flag unresolved, or set to `no-ads`, or for a signed-in member, or for headless or automated browsers, nothing renders and no ad script loads.
**Depends on:** Google approval (after Step 1) and Owner Step 2.
**Risks:**
1. Our own CI and monitoring loading real ads, which AdSense counts as invalid traffic (**P0**). Mitigation: B-T4.
2. A slow kill switch. Mitigation: a runtime flag, with no rebuild needed.
3. Ad clipping or layout shift. Mitigation: a fixed 300×250 box.

### Task B-T1: Owner dashboard runbook (agent sends it, owner clicks)
- **Complexity:** S
- **Depends on:** Approval
- **Files:** none (the agent then commits the slot ID in B-T2)
- **Description:** The owner does this in AdSense, about 20 minutes:
  1. **Ads → By ad unit → Display ads:** create one unit, `bwsc-show-inline`, at a **fixed 300×250** size (not responsive). Send the agent its `data-ad-slot` number. [CHANGED: fixed size; a responsive unit can be taller than its box and get clipped, which breaks AdSense policy; structure reviewer, user-impact reviewer]
  2. **Ads → By site → broadwayscorecard.com:** turn **Auto ads off**. Also confirm each Auto ads format is off: anchor, vignette, side rail, multiplex, and "ad intents" (which turns page text into ad links). The fixed unit's script can otherwise switch them on. [CHANGED; user-impact reviewer]
  3. **Optimization:** turn off "Allow Google to run experiments" / auto-optimize, if offered. It can change ad formats without notice. [CHANGED; user-impact reviewer; confirm the current label in the UI]
  4. **Privacy & messaging:**
     - Create a **European regulations** message (covers UK, EEA, CH) with the `/privacy` URL, as a **safety net only**. The site won't serve ads to those visitors (B-T9), but if the region check ever misses someone (for example, a traveller on a VPN), Google's consent message still protects you. Make sure it shows a clear "Do not consent" choice.
     - Create a **US state regulations** message targeted at "All current and future supported US states."
     - Preview both, ideally from a UK VPN.
  5. **Brand safety → Blocking controls → Advertiser URLs:** paste the blocklist below.
  6. **Sensitive categories:** block gambling, dating and get-rich-quick style categories. The names may differ in the current UI; pick the closest matches.
  7. **Emergency stop (for later):** AdSense → Sites lets you stop ads on the site from the dashboard. The PostHog flag (B-T7) is the faster switch.
  8. Payments and tax info can wait until AdSense asks; it pays out at $100.

  **Advertiser URL blocklist (copy-paste):**
  ```
  stubhub.com
  seatgeek.com
  vividseats.com
  ticketmaster.com
  ticketmaster.co.uk
  livenation.com
  telecharge.com
  broadway.com
  broadwaydirect.com
  ticketnetwork.com
  tickpick.com
  gametime.co
  theatermania.com
  atgtickets.com
  londontheatredirect.com
  lovetheatre.com
  seatplan.com
  officiallondontheatre.com
  nimaxtheatres.com
  lwtheatres.co.uk
  delfontmackintosh.co.uk
  viagogo.com
  ```
  TodayTix is not blocked: its ads send buyers to the partner you already earn from. Watch item: one reviewer raised a low-confidence concern that a click on a TodayTix Google ad could override your Impact last-click credit. Check Impact attribution in week 4.
- **Acceptance criteria:**
  - VERIFY: the slot ID is committed in `src/lib/ads.ts` (B-T2)

### Task B-T2: `src/lib/ads.ts`: decision function, loader, slot config
- **Complexity:** M
- **Depends on:** B-T1
- **Parallel:** Yes (with B-T3)
- **Files:** `src/lib/ads.ts` (extend), `tests/unit/ads-decision.test.ts` (new)
- **Description:** [CHANGED: split the original L-sized AdSlot; logic moved to `src/lib` per existing patterns; design reviewer]
  - **`AD_SLOTS`:** `{ showInline: { id: '<slot>', width: 300, height: 250 } }`. Size lives with the slot, not in the component.
  - **`loadAdSense(): Promise<boolean>`:** a module-level promise that injects `adsbygoogle.js?client=…` once (async, `crossorigin="anonymous"`). It resolves `false` when the script fails or is blocked. It follows `src/lib/apple-auth.ts:43-62` (`loadAppleSDK`).
  - **`isAutomatedBrowser(): boolean`:** true when any of these hold:
    - `navigator.webdriver === true`
    - the user agent matches `/HeadlessChrome|Lighthouse|PageSpeed|Chrome-Lighthouse|GTmetrix|Playwright/`
    - the URL has `?noads=1`
    - a `bwsc_noads=1` cookie is set

    [CHANGED: global automation opt-out; P0, pre-mortem + structure reviewer]
  - **`decideAdRender({ variant, authLoading, isAuthenticated, automated, region })`:** a pure function. It returns `true` **only** when all hold:
    - `variant === 'ads'`
    - `!authLoading`
    - `!isAuthenticated`
    - `!automated`
    - `region === 'ads-ok'` (from the B-T9 cookie; a missing or unknown value means **no ads**)

    An unresolved flag (`undefined`) means **no ads**. [CHANGED: wait for auth to finish loading; user-impact reviewer, structure reviewer; unresolved flag means no ads, so the kill switch works; design reviewer, pre-mortem]
- **Acceptance criteria:**
  - VERIFY: the unit test imports the real `decideAdRender` and `isAutomatedBrowser` (CLAUDE.md §15) and passes at least 12 cases, including undefined variant, auth loading, a signed-in member, `no-ads`, each automation signal, and the happy path

### Task B-T3: `usePostHogFlag` hook (shared)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/lib/hooks/usePostHogFlag.ts` (new), `src/lib/hooks/index.ts`
- **Description:** Extract the existing polling loop (`TicketButtonsAB.tsx:95-125`, `ProGateContext.tsx:350-362`): poll `window.posthog?.getFeatureFlag(key)` every 250ms, 20 tries, and return `undefined` until it resolves. Do **not** rewrite the two existing call sites in this plan; file a Linear issue to migrate them. [CHANGED: no third copy of the polling loop; design reviewer]
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` is clean; `AdSlot` uses the hook

### Task B-T4: Keep our own automation from loading real ads (P0)
- **Complexity:** M
- **Depends on:** B-T2
- **Parallel:** Yes (with B-T5)
- **Files:** a shared Playwright fixture or `playwright.config.ts` (`use.extraHTTPHeaders` won't do it; use a global `page.route` in a fixture applied to every project), plus the scripts behind `/visual-qa` and `lighthouse-post-deploy.yml` where they open pages
- **Description:** [CHANGED: new task; P0 from the pre-mortem, structure reviewer and external GPT reviewer]
  - Today, `test.yml:6592` and `:6699` run e2e tests with `TEST_BASE_URL: https://broadwayscorecard.com`. `vercel-deploy.yml:641` runs `smoke.spec.ts` against production after every deploy. `lighthouse-post-deploy.yml` audits `/show/*` pages daily.
  - Belt and braces:
    - (a) `isAutomatedBrowser()` in B-T2 already stops the slot from rendering for headless and Lighthouse runs
    - (b) block `**/*googlesyndication.com/**`, `**/*doubleclick.net/**` and `**/*adtrafficquality.google/**` in a fixture shared by every Playwright project
    - (c) add `?noads=1` or the cookie to the Lighthouse URL list and to the `/visual-qa` page loader
  - Touching `.github/workflows/**` is shared infrastructure: run `/second-opinion` first (CLAUDE.md §18). Prefer changing scripts and fixtures over workflows where possible.
- **Acceptance criteria:**
  - VERIFY: `grep -rn "googlesyndication" tests/` shows the block in the shared fixture, not just one spec
  - VERIFY: with the flag forced to `ads`, `npx playwright test tests/e2e/smoke.spec.ts` against a local `next start` makes zero requests to `googlesyndication.com` (asserted in a test)

### Task B-T5: `AdSlot` component + show-page placement
- **Complexity:** L
- **Depends on:** B-T2, B-T3, B-T9
- **Parallel:** No
- **Files:** `src/components/ads/AdSlot.tsx` (new), `src/app/show/[slug]/page.tsx`, `memory/design-system.md`
- **Description:**
  - **API:** `<AdSlot slot="showInline" />`. Placement belongs to the caller, so there is no route allowlist. [CHANGED: removed `isAdEligiblePath` and its 20-case test; the page decides by including the component; design reviewer]
  - **Render decision:** render when `decideAdRender({ variant: usePostHogFlag('ads'), ...useAuth(), automated: isAutomatedBrowser() })` is true. When it's false, render **nothing**: no reserved box, no label.
  - **Load sequence:** when it's true and an IntersectionObserver (`rootMargin: '400px'`) fires, call `loadAdSense()`. Only if that resolves `true`, render the labeled box at a fixed 300×250 (centered, `max-width: 100%`) with the `<ins>`, then push once. [CHANGED: no empty box for ad-blocker users or the no-ads group; user-impact reviewer; no `overflow:hidden` clipping and no responsive full-width; structure reviewer]
  - **Layout shift:** the box appears below the fold, before the reader reaches it, so the shift is not visible.
    - Measure at **both** 390×844 and 1440×900. If on desktop the slot's position is within the first viewport + 400px on load, move it further down. [CHANGED: check desktop too; structure reviewer]
    - If an approved creative comes back `unfilled`, collapse the box. This is still invisible, for the same reason.
  - **Label:** "Advertisement", using design-system text tokens and `bg-surface-raised`. Score badges are untouched.
  - **Route changes:** key the `<ins>` on `usePathname()` so client-side navigation gets a fresh unit.
  - **Analytics:** fire `captureEvent('ad_slot_rendered', { slot })` from `src/lib/posthog-events.ts` when the unit fills.
  - **Placement:** in `src/app/show/[slug]/page.tsx`, after the Critic Scorecard `<section id="critic-reviews">` (~line 1010) and before `TourScheduleCard` / `ShowPageBelowFoldLoader` (~1014–1039). That keeps it far from the hero's `TicketButtonsAB` and above `ShowtimesCard` and `LotteryRushCard`, which carry ticket links. Update the section-order comment.
- **Acceptance criteria:**
  - VERIFY: a local `NODE_ENV=production next build && next start` with the flag forced to `ads` in your browser shows one 300×250 labeled ad on one Broadway, one West End and one Off-Broadway show page. [CHANGED: run locally; there is no flag-on preview environment; `vercel-preview.yml` builds only `staging`; structure reviewer]
  - VERIFY: the same pages show **no** box with the flag unresolved, with `no-ads`, when signed in, or with uBlock enabled
  - VERIFY: `/visual-qa` passes; the ad's top is at least 800px below the first `TicketLink` at 390×844

### Task B-T6: Bot challenge in the Vercel firewall (start early)
- **Complexity:** S
- **Depends on:** None. **Start in Log mode as soon as Phase A lands**, so the 3-day observation is done before launch. [CHANGED: moved earlier; the Log→Challenge switch was unassigned; structure reviewer]
- **Files:** none (Vercel firewall custom rule, through the Vercel connector with owner approval, or by the owner in the dashboard)
- **Description:**
  - **The rule:** challenge requests from `CN` or `HK`, **excluding** `/ads.txt`, `/api/*`, `/embed/*`, `/robots.txt`, `/sitemap*` and feeds. [CHANGED: scoped to HTML pages; user-impact reviewer, external GPT reviewer]
  - **Evidence:** 7,112 CN/HK/SG sessions in 28 days, with 26 showing any interaction. These bots run JavaScript (PostHog recorded them), so they would load ads.
  - **Rollout:** run in Log mode for 3 days, then switch to Challenge. The agent that ran Phase A sets a Linear due date for the switch.
  - **Rollback:** disable the rule in the dashboard.
- **Acceptance criteria:**
  - VERIFY: the rule is active and excludes the listed paths
  - VERIFY: one week after Challenge, PostHog CN+HK pageviews are down at least 80%, and `curl -s https://broadwayscorecard.com/ads.txt` still returns 200 from an HK test (if a VPN is available)

### Task B-T7: Register the flag, then launch at 50/50
- **Complexity:** S
- **Depends on:** B-T4, B-T5 landed and deployed; owner "go"
- **Files:** `scripts/lib/flag-registry.js` (add `ads`), `docs/experiments/ads.md` (new, short: hypothesis, metric, duration, end states); PostHog flag `ads` created through the API before the code lands (`docs/experiments/README.md`)
- **Description:** [CHANGED: one runtime flag replaces the build-time `ads` flag plus `ads-holdout`; design reviewer, pre-mortem, structure reviewer; 50/50 instead of 85/15 because 15% of ~1,500 ticket clicks a month can't detect anything; structure reviewer]
  - The flag has variants `ads` / `no-ads`, bucketed per person, with a release condition covering 100% of users. It ships at **0% `ads`**.
  - At launch, set it to 50/50 for 4 weeks.
  - **Kill switch:** set it to 100% `no-ads`. It takes effect on the next page load with no rebuild, and anyone whose PostHog fails to load gets no ads anyway.
  - **End states:**
    - **Keep:** 100% `ads`; the flag stays as the kill switch.
    - **Pull:** 0% `ads`, then remove `AdSlot`, `src/lib/ads.ts`, `src/app/ads.txt`, the meta tag, the flag-registry entry and the firewall rule. [CHANGED: end state written down; design reviewer]
- **Acceptance criteria:**
  - VERIFY: the flag exists in PostHog with both variants; `flag-registry.test.mjs` passes
  - VERIFY: after launch, PostHog shows `$feature_flag_called` for `ads` with a roughly 50/50 split within 48 hours

### Task B-T8: Week-4 readout (one-off, no new pipeline)
- **Complexity:** M
- **Depends on:** 4 weeks after B-T7
- **Files:** `scripts/analyze-ads-test.js` (new, `--json`), following `docs/experiments/README.md` (f) analyzer conventions; no monitor workflow
- **Description:** [CHANGED: replaces S4-T1/T2/T3 (weekly email block, guardrails, decision script) with one readout; the weekly email already reaches the owner and $35–135/month doesn't justify a new pipeline; structure reviewer, external GPT reviewer, design reviewer]
  - **From PostHog:** for each variant, real show-page pageviews and `ticket_click` per 1,000 show-page pageviews, with a 95% confidence interval. Join on `$feature/ads` on the events, and only count people who resolved the flag.
  - **Ad revenue:** enter the AdSense earnings for the 4 weeks by hand from the dashboard, as `--adsense=<dollars>` on the command line. It's one number. Use Impact tracked actions by `subId1`/distinct_id for the commission split, not paid commission (paid lags ~2 months).
  - **Output:**
    - total revenue per 1,000 pageviews for each group, minus the Vercel Pro cost if it was an upgrade
    - the click-rate ratio and its confidence interval
    - CLS p75 from the existing `check-cwv-health`
    - a plain-English recommendation: keep / pull / run 4 more weeks if the confidence interval straddles the threshold
  - Email it to the owner via the transactional `--send-to` path (CLAUDE.md §17).
- **Acceptance criteria:**
  - VERIFY: running on the real 4 weeks prints both groups with sample sizes and a confidence interval; running on a 1-day window doesn't crash and says "not enough data"


### Task B-T9: Region gate: no ads for UK/EEA/CH visitors
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes (with B-T2, B-T3)
- **Files:** `src/middleware.ts`, `src/lib/ads.ts` (export `NO_AD_COUNTRIES` and a pure `adRegionForCountry(code)`), `tests/unit/ads-decision.test.ts`
- **Description:** [CHANGED: new task; owner decision 2026-10-22]
  - **Where:** `src/middleware.ts` already runs on `/show/:slug+`. On requests it does **not** redirect, return `NextResponse.next()` and set a first-party cookie `bwsc_ad_region`:
    - `ads-ok` when the `x-vercel-ip-country` header is a country outside the list
    - `no-ads` when it's in the list or missing
    - `Path=/`, `Max-Age=86400`, `SameSite=Lax`, not HttpOnly, so `AdSlot` can read it
  - **The list:** the EU-27, plus Iceland, Liechtenstein, Norway, the UK and Switzerland: `AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH`.
  - **Matcher:** do **not** change the middleware `matcher`. `tests/unit/middleware-slug-redirects.test.mjs` asserts it matches the redirect route families, and show pages are already covered. The redirect path stays exactly as it is.
  - **No cookie banner:** the cookie stores no identifier, only a yes/no for ad eligibility. It exists to keep tracking cookies away from UK/EEA visitors.
  - **Ireland:** IE is in the list (EU). That removes a small slice of the CA/AU/NZ/IE premium traffic counted earlier.
- **Acceptance criteria:**
  - VERIFY: the unit test covers `adRegionForCountry` for GB, IE, DE, CH, NO, US, CA, AU and an empty value, and `decideAdRender` returns false for `region: 'no-ads'` and `undefined`
  - VERIFY: `tests/unit/middleware-slug-redirects.test.mjs` still passes unchanged
  - VERIFY: after deploy, a browser on a UK VPN gets `bwsc_ad_region=no-ads` on `/show/<slug>`, and a US browser gets `ads-ok`. Vercel sets the country header at its edge, so a curl with a fake header won't test this.

---

## Phase C: Optional, only if Phase B says keep
- **C-T1 Browse-list slot:**
  - `browse/[slug]/page.tsx` passes an `adSlot` prop to `BrowseListClient`; `best/[category]` does not.
  - Render the slot **outside** `filteredAndSorted.map`, at a fixed position (for example after the list header or after a fixed first chunk), so changing filters or sort doesn't remount it and re-request an ad.

  [CHANGED: no slot inside the filtered map; placement by prop, not URL; structure reviewer, design reviewer]
- **C-T2 Weekly ad-revenue line:**
  - Add one "Ads this week" line to the traffic email.
  - Read GA4 `totalAdRevenue` through a new `scripts/lib/ga4-ad-revenue.js` (pure aggregation, a sibling of `ga4-engaged-sessions.js`) using the existing `getGaClient()` and the **existing** `GA4_PROPERTY_ID` / `GA_SERVICE_ACCOUNT_KEY` secrets (`analyze-traffic-sources.yml:56-57`). No new secrets, no workflow edit.
  - Keep it out of the `traffic-history.json` all-or-nothing write. A GA4 failure prints "Ads: unavailable" and never blocks the history store.

  [CHANGED: reuse existing GA4 client and secrets; isolated from history writes; design reviewer, structure reviewer]

---

## Dependencies Graph
```
Owner Step 0 → A-T1 ─┐
               A-T2 ─┴→ Phase A lands → Owner Step 1 (Request review) ──→ Google approval
Phase A lands → B-T6 (Log 3 days → Challenge)
Google approval → B-T1 (owner runbook) → B-T2 ─┐
                                 B-T3, B-T9 ───┼→ B-T5 ─┐
                                 B-T2 → B-T4 ──┴────────┼→ B-T7 (owner "go") → 4 weeks → B-T8 → keep? → Phase C
                                 B-T6 (Challenge active) ┘
```

## Subagent Execution Map
```
Session A (now, ~1 hour):     A-T1 ∥ A-T2 → land → start B-T6 in Log mode
Session B (after approval):   track 1: B-T2 → B-T5
                              track 2: B-T3, B-T9, then B-T4 (after B-T2)
                              sync → land → B-T7 at 0% → owner "go" → 50/50
Session C (week 4):           B-T8
Session D (optional):         C-T1, C-T2
```
**Critical path:** Step 0 → Phase A → Google review (the real bottleneck) → Phase B → 4 weeks → B-T8.
**Max subagent parallelism:** 2.

## Known Edge Cases
- **UK/EEA/CH visitors (owner decision 2026-10-22: no ads).** Google's consent message would otherwise appear mid-scroll on West End pages, contradicting "no pop-ups". B-T9 keeps the ad script from ever loading for those visitors, so no consent dialog appears. Edge cases:
  - travellers and VPN users are classified by IP country at request time
  - a missing country header means no ads
  - the European consent message in B-T1 is a safety net, not the plan

  Separately, GA4 and PostHog session replay already run without consent for UK visitors. That gap predates this plan; file it in Linear. [CHANGED: UX decision resolved by the owner; raised by user-impact reviewer, structure reviewer]
- **CSP is report-only.** AdSense iframes will log `frame-src 'none'` violations. Harmless now. Add the AdSense domains in B-T5 if the report noise matters, or before the CSP is ever switched to enforcing. Avoid `img-src https:`; prefer listing domains. [CHANGED; external GPT reviewer]
- **Ad blockers and PostHog blockers** get no ads and no flag, so they're absent from both test groups. This is fair, because the two blockers overlap heavily.
- **Members during auth loading** never load the script, because the decision waits for `!authLoading`.
- **Self-clicks:** the owner must never click their own ads. Use `?noads=1` or the `bwsc_noads` cookie when browsing your own site.
- **iOS app:** native (separate repo). If any app web view loads show pages, it should add `?noads=1`. Confirm in that repo.
- **`/embed/*`** never includes `AdSlot`.
- **Holdout join:** `subId2` on ticket links is already used for the ticket-button test (`affiliate-utils.ts`). Join Impact actions by `subId1`/distinct_id instead.
- **CLAUDE.md drift:** it says "Next.js 14, static export", but the repo runs Next.js 15.5 with ISR and middleware. File a Linear issue; don't fix it in this plan.

## Changes from Critique

| Change | Reason | Source |
|---|---|---|
| Phase A = ads.txt + meta + privacy only; request review before writing ad code | Google approval can end the plan; don't build first | Structure reviewer, Phase 0 |
| Global automation opt-out (UA/webdriver/`?noads=1`/cookie + shared Playwright block) | CI e2e, post-deploy smoke and Lighthouse all hit production; would create invalid ad traffic (P0, verified at `test.yml:6592,6699`, `vercel-deploy.yml:641`) | Pre-mortem, structure reviewer, external GPT reviewer |
| One runtime PostHog flag replaces the build-time flag + holdout flag | Kill switch must work in seconds; build flag waited up to 6h; two gates overlapped | Design reviewer, pre-mortem, structure reviewer, external GPT reviewer |
| Unresolved flag = no ads | So the kill switch reaches everyone, and every ad viewer is bucketed | Design reviewer |
| 50/50 for 4 weeks instead of 85/15 | ~1,531 ticket clicks / 28 days; a 15% holdout can't detect a 10% drop | Structure reviewer |
| Fixed 300×250, no `overflow:hidden`, no full-width responsive | Clipped ads break AdSense policy; responsive units can be taller than their box | Structure reviewer, user-impact reviewer |
| Render nothing until the script loads | Ad-blocker users would otherwise see an empty "Advertisement" box | User-impact reviewer |
| Gate on `!authLoading` | Members could load ads before auth resolves, breaking the privacy promise | User-impact reviewer, structure reviewer |
| Removed `isAdEligiblePath` route allowlist | The page that includes `AdSlot` already decides placement | Design reviewer |
| Logic in `src/lib/ads.ts`; shared `usePostHogFlag` hook | Match the `apple-auth.ts` loader pattern; avoid a third polling copy; testable pure function | Design reviewer |
| Browse slot moved to optional Phase C, outside the filtered map | Filter changes would re-request ads (policy risk) | Structure reviewer |
| Weekly email block, guardrails and decision script replaced by one week-4 readout | Not worth a pipeline at $35–135/month; guardrail could never fire at this volume | Structure reviewer, external GPT reviewer, design reviewer |
| GA4 work reuses `ga4-client.js` and existing secrets | `GA_SERVICE_ACCOUNT_KEY` / `GA4_PROPERTY_ID` already wired | Design reviewer |
| Firewall rule scoped to HTML pages and started early in Log mode | Don't challenge `/ads.txt` or APIs; the 3-day Log window was unscheduled | User-impact reviewer, structure reviewer, external GPT reviewer |
| More AdSense defaults to turn off (all Auto ads formats, ad intents, experiments) | Platform defaults can add ads the code never asked for | User-impact reviewer |
| Privacy wording true before and after launch | Original wording claimed consent prompts weeks before they existed | User-impact reviewer |
| No ads for UK/EEA/CH visitors (new B-T9 region gate) | Avoids Google's consent pop-up entirely; costs ~15% of impressions at lower-than-US rates | Owner decision 2026-10-22, after user-impact and structure reviewers raised the pop-up |
| Vercel Pro cost subtracted in the decision metric | $20/month is 15–57% of projected revenue | Structure reviewer |
| Dropped CSP edits and robots allow from the pre-approval path | Report-only CSP; `*` already allows the crawler | External GPT reviewer, structure reviewer |

## Key Risks
1. **AdSense rejects the site** as low-value content, since show pages are data-heavy. Mitigation: Phase A costs about an hour, so a rejection wastes little. Reapply after 2–4 weeks with editorial guide pages prominent. Mediavine Journey is the fallback.
2. **Invalid-traffic action against the account.** Mitigation: B-T4 automation opt-out, the B-T6 bot challenge, the self-click rule, and checking AdSense impressions against PostHog `ad_slot_rendered` in the week-4 readout.
3. **Ads cost more TodayTix revenue than they earn.** Mitigation: placement far from ticket links, the competitor blocklist, the 50/50 test with a confidence interval, and an instant flag-based kill switch.
