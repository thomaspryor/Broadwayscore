# Sprint Plan: AdSense Launch (low-effort, low-clutter ads)

## Overview
Add Google AdSense to broadwayscorecard.com (which also serves West End Scorecard at `/west-end`) with at most one manually placed ad per page, no pop-ups, sticky ads, video or Auto ads, and no ads for signed-in users. Agents (Claude or Codex) do all code work behind a build-time kill switch. The owner spends about 45 minutes in total, in four short sittings, in the AdSense and Vercel dashboards. A PostHog holdout group measures whether ads reduce TodayTix ticket clicks, so the 30-day keep/pull decision rests on data instead of guesswork.

**Expected revenue at launch:** about $35–135/month with one ad per eligible page at today's ~56k real pageviews a month (bot-filtered PostHog, 30 days to Oct 19, 2026; ~89–90% of human traffic is US/UK/CA/AU/NZ/IE). Revenue scales roughly linearly with traffic. These are planning estimates, not quotes.

**Decision metric (owner-agreed):** total revenue per 1,000 real pageviews = AdSense revenue + TodayTix/Impact commission, compared between the ads group and the no-ads holdout, alongside ticket-click rate and CLS.

## Owner Checklist (the only manual work)

| When | What | Time |
|---|---|---|
| **Step 0, before Sprint 1** | (a) Confirm the Vercel team "thomaspryor's projects" is on **Pro**, not Hobby. Vercel's fair-use rules ban commercial use on Hobby and name AdSense explicitly; a Hobby site with ads can be paused. (b) Sign up at adsense.google.com, add `broadwayscorecard.com`, and send the agent your publisher ID (`ca-pub-…`). It is public, not a secret. | 15 min |
| **Step 1, after Sprint 1 is live** | In AdSense → Sites, click **Request review**. Approval usually takes days to a couple of weeks. | 2 min |
| **Step 2, after approval** | Follow the S3-T1 runbook: create 2 display ad units and send the agent their slot IDs, confirm Auto ads are off, turn on the two consent messages, paste the blocklist, and link AdSense to GA4. Payment and tax details can wait until AdSense asks (it pays out at $100). | 15 min |
| **Step 3, at launch** | Reply "go" to flip the `ads` flag on in production (S3-T4). | 1 min |
| **Step 4, day 30** | Read the decision report (S4-T3) and choose keep, expand or pull. | 10 min |

## Sprint Summary

| Sprint | Goal | Tasks | Complexity |
|---|---|---|---|
| 1 | Verification-ready site: ads.txt, meta tag, privacy policy, CSP, robots | 5 | 4S, 1M |
| 2 | `AdSlot` component + two placements behind the `ads` flag (off in prod) | 6 | 2S, 3M, 1L |
| 3 | Post-approval launch: dashboard runbook, bot challenge, holdout flag, flip flag | 4 | 3S, 1M |
| 4 | Measurement: ad revenue in weekly email, guardrails, 30-day decision report | 3 | 1S, 2M |

Total: **18 tasks**, about 2–3 agent sessions. Sprints 1 and 2 can run in one session; Sprint 3 waits on Google's approval; Sprint 4 can start as soon as Sprint 3 lands.

**Who can run what:** Sprints 1, 2 and 4 are plain repo work, which suits either a Claude cloud session (lands via `land/bro-N-<slug>`) or a Codex task (edit in place, then the owner's "Create PR" button; the branch must be `codex/<slug>` if one is created). S3-T2 and S3-T4 need the Vercel connector, so they suit a Claude session. Every sprint gets a Linear issue (`linear-brain.js create`) per CLAUDE.md §6.

---

## Sprint 1: Verification-ready site (no ads shown)
**Demo:** `curl https://broadwayscorecard.com/ads.txt` returns the Google line. The homepage `<head>` contains `<meta name="google-adsense-account" content="ca-pub-…">`. `/privacy` describes AdSense. No ad renders anywhere.
**Depends on:** Owner Step 0 (publisher ID).
**Risks:** Editing `vercel.json` headers may count as shared infrastructure (CLAUDE.md §18). Mitigation: run `/second-opinion` before S1-T4 if the infra-review gate fires.

### Task S1-T1: Ads config module
- **Complexity:** S
- **Depends on:** Owner Step 0
- **Parallel:** No (everything else imports it)
- **Files:** `src/config/ads.ts` (new)
- **Description:** Single source of truth for ads. Export:
  - `ADSENSE_CLIENT` (the `ca-pub-…` string, committed; it is public)
  - `AD_SLOTS = { showInline: '', listInline: '' }`, filled in S3-T1 once the owner creates the units
  - `isAdEligiblePath(pathname: string): boolean`, an allowlist: `/show/[slug]` and `/browse/[slug]` only. Everything else returns false, including `/`, `/west-end`, `/off-broadway`, `/opera` landings, methodology pages, `/privacy`, `/terms`, all discount/lottery/rush/standing-room pages (both markets), `/diary-show/*`, `/my-shows`, `/seen/*`, `/plans/*`, `/admin/*`, `/auth/*`, `/embed/*`, `/studio`, `/dev`, `/test`, `/unsubscribe`, `/unfollow`, `/feedback`, `/submit-review`.
  - `adsEnabled()`: true only when `featureFlags.ads` is on AND `ADSENSE_CLIENT` is non-empty
- Add `ads` to `src/config/feature-flags.ts` as a normal build-time flag read from `NEXT_PUBLIC_FEATURES`. Confirm it is **not** in `PROD_HELD_FEATURES` (`scripts/lib/prod-held-flags-guard.js`), so the owner can turn it on later.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` has zero errors in changed files
  - VERIFY: the unit test from S2-T6 passes for at least 20 allow/deny paths

### Task S1-T2: ads.txt route + verification meta tag
- **Complexity:** S
- **Depends on:** S1-T1
- **Parallel:** Yes (with S1-T3, S1-T4, S1-T5)
- **Files:** `src/app/ads.txt/route.ts` (new), `src/app/layout.tsx` (modify the `metadata` export)
- **Description:**
  - The route handler returns `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0` as `text/plain`, with `export const dynamic = 'force-static'`. Derive `pub-…` by stripping the `ca-` prefix from `ADSENSE_CLIENT`, and return 404 when the client ID is empty.
  - Add `other: { 'google-adsense-account': ADSENSE_CLIENT }` to the root metadata. This is Google's meta-tag verification method, so review can proceed without loading any ad script.
  - Both ship **independently of the `ads` flag**, because Google must see them before approval.
- **Acceptance criteria:**
  - VERIFY: after deploy, `curl -s https://broadwayscorecard.com/ads.txt` prints exactly one Google line
  - VERIFY: `curl -s https://broadwayscorecard.com/ | grep -c 'google-adsense-account'` returns 1

### Task S1-T3: Privacy policy update
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/app/privacy/page.tsx`
- **Description:**
  - Replace the sentence at ~line 152 ("We don't show third-party ads or share your data with ad networks."). It must not stay up once ads can render.
  - Add a short "Advertising" section: some pages show ads from Google AdSense; Google and its partners may use cookies or device identifiers to serve and measure ads; visitors in the UK, EEA and Switzerland are asked for consent first; US visitors can opt out of personalized ads; signed-in members see no ads.
  - Link to Google's "How Google uses information from sites or apps that use our services" page and to Google's ad personalization settings.
  - Add Google AdSense to the "Services We Use" list (~159–171) and bump "Last updated" (line 31).
  - Keep the tone and structure of the existing page. Do not touch the affiliate (Impact) wording.
- **Acceptance criteria:**
  - VERIFY: `grep -c "don&apos;t show third-party ads" src/app/privacy/page.tsx` returns 0
  - VERIFY: the page builds and `/visual-qa` passes on `/privacy`

### Task S1-T4: CSP (report-only) allowances for AdSense
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `vercel.json` (the CSP at ~line 1572; the policy is `Content-Security-Policy-Report-Only`)
- **Description:** The policy is report-only, so nothing breaks today. Still, keep it accurate so a future switch to enforcing does not silently kill ads. Add:
  - `script-src`: `https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.gstatic.com https://*.adtrafficquality.google`
  - `frame-src`: replace `'none'` with `https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://www.google.com https://*.adtrafficquality.google`
  - `img-src`: add `https:` (ad creatives come from many CDNs)
  - `connect-src`: `https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com`
  - Do not touch the `/embed/(.*)` override, `X-Frame-Options: DENY` (it only controls framing *of* our pages) or `Permissions-Policy`.
- **Acceptance criteria:**
  - VERIFY: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"` exits 0
  - VERIFY: `grep -o "frame-src[^;]*" vercel.json` no longer contains `'none'` for the `/(.*)` rule

### Task S1-T5: robots: explicit Mediapartners-Google allow
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `src/app/robots.ts`, `tests/unit/robots-api-disallow.test.ts`
- **Description:** AdSense's crawler (`Mediapartners-Google`) is allowed today only through the `*` rule. Add an explicit rule giving it the same `CRAWLABLE_SURFACE`, so a future tightening of `*` or of the AI-bot list cannot accidentally block it. Leave `Google-Extended` disallowed; it has no effect on AdSense. Extend the existing unit test.
- **Acceptance criteria:**
  - VERIFY: the robots unit test passes and asserts that `Mediapartners-Google` is not disallowed from `/show/`

**Sprint 1 ship:** tsc, lint and build per CLAUDE.md §12; `/visual-qa` for the privacy page; land; confirm with `node scripts/check-prod-deploy.js HEAD --wait`. Then tell the owner to do Step 1 (Request review).

---

## Sprint 2: AdSlot component + placements (flag off in production)
**Demo:** On a preview deploy built with `NEXT_PUBLIC_FEATURES=...,ads`, a show page shows one labeled ad box below the critic reviews; a long browse list shows one box after the 6th card. Signed-in users and excluded routes show nothing. Production is unchanged because the flag is off.
**Risks:** (1) Layout shift hurting SEO (73% of visits come from search). Mitigation: fixed reserved height, below the fold only, lazy-loaded. (2) Ads near the TodayTix button cannibalizing clicks. Mitigation: placement rules plus the holdout in S3-T3. (3) App Router client-side navigation reusing a stale `<ins>`. Mitigation: re-key the slot on pathname.

### Task S2-T1: AdSense script loader (load once, on demand)
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** Yes (with S2-T2)
- **Files:** `src/components/ads/AdSenseLoader.tsx` (new)
- **Description:**
  - The loader injects `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=<ADSENSE_CLIENT>` (async, `crossorigin="anonymous"`) **only** when the first `AdSlot` mounts and becomes near-visible. The script never loads on excluded routes or for signed-in users, which also keeps their pages lighter.
  - Use a module-level promise so the script is injected at most once per page lifecycle.
  - Prefer a plain injected `<script>` over `next/script`. `next/script` adds a `data-nscript` attribute that AdSense logs a warning about. Either works if the warning is accepted.
  - Do **not** mount the loader in `AnalyticsWrapper`. The ads code stays separate from analytics.
- **Acceptance criteria:**
  - VERIFY: on a preview with the flag on, DevTools shows exactly one `adsbygoogle.js` request on a show page, and none on `/`, `/privacy` or `/my-shows`

### Task S2-T2: `AdSlot` component
- **Complexity:** L
- **Depends on:** S1-T1
- **Parallel:** Yes (with S2-T1)
- **Files:** `src/components/ads/AdSlot.tsx` (new), `memory/design-system.md` (document the component)
- **Description:** A client component, `<AdSlot slot="showInline" | "listInline" />`. It renders null unless **all** of these are true:
  - `adsEnabled()`
  - `isAdEligiblePath(usePathname())`
  - `!useAuth().isAuthenticated` (ad-free for members)
  - the holdout variant is not `no-ads` (wired in S3-T3; until then, treat as eligible)

  Behavior:
  - **Reserved space:** the wrapper gets a fixed `min-height` per breakpoint (mobile ~300px for a 300×250 creative plus label; desktop ~280px for responsive). It also gets `max-width: 100%` and `overflow: hidden` so no horizontal scroll.
  - **Label:** a small "Advertisement" label above the ad, using design-system text tokens and `bg-surface-raised`. No custom colors, no `zinc-*`/`slate-*`.
  - **Lazy:** an IntersectionObserver with `rootMargin: '600px'`. Only when it fires does the slot call the loader, render `<ins class="adsbygoogle" data-ad-client data-ad-slot data-ad-format="auto" data-full-width-responsive="true">` and push `(window.adsbygoogle = window.adsbygoogle || []).push({})` once.
  - **Route changes:** key the inner `<ins>` on `pathname`, so client-side navigation creates a fresh unit instead of pushing into a filled one.
  - **Unfilled:** when the `ins` gets `data-ad-status="unfilled"`, collapse the wrapper. This is safe because the slot is below the fold and loads before it scrolls into view.
  - **Signed-in hydration:** the server renders the reserved box (most visitors are anonymous); for signed-in users the client removes it. The shift happens below the fold and affects few users. Document this in Known Edge Cases.
  - **Analytics:** fire a PostHog `ad_slot_rendered` event (slot name, path) when the unit fills, for per-slot coverage numbers.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` and `npx next lint` are clean
  - VERIFY: the Playwright spec from S2-T5 passes on a flag-on preview

### Task S2-T3: Show page placement
- **Complexity:** M
- **Depends on:** S2-T2
- **Parallel:** Yes (with S2-T4)
- **Files:** `src/app/show/[slug]/page.tsx`
- **Description:**
  - Insert `<AdSlot slot="showInline" />` **after the Critic Scorecard `<section id="critic-reviews">` (~line 1010) and before `TourScheduleCard` / `ShowPageBelowFoldLoader` (~1014–1039)**. That puts it well below `ShowHeroRedesign`'s score and `TicketButtonsAB` (~821 in the hero), and above `ShowtimesCard` and `LotteryRushCard`, which carry ticket links.
  - Do not place ads inside the hero, the score cards, the reviews list, `ShowtimesCard`, `LotteryRushCard`, `TourScheduleCard` or any component that renders a `TicketLink`.
  - Update the section-ordering comment (~1017–1036).
  - Score badges are untouched (`w-20 sm:w-24`).
- **Acceptance criteria:**
  - VERIFY: the Playwright spec asserts the ad wrapper's top is at least 800px below the first `TicketLink` on a 390×844 viewport
  - VERIFY: `/visual-qa` passes on one Broadway, one West End and one Off-Broadway show page with the flag on

### Task S2-T4: Browse list placement
- **Complexity:** S
- **Depends on:** S2-T2
- **Parallel:** Yes (with S2-T3)
- **Files:** `src/components/BrowseListClient.tsx` (the `filteredAndSorted.map` at ~259–276)
- **Description:** Render one `<AdSlot slot="listInline" />` after the 6th `ShowListCard`, and only when the filtered list has at least 10 items. Never more than one per page. Wrap it in a list-appropriate element so list semantics and keyboard order stay sane.
- **Acceptance criteria:**
  - VERIFY: the Playwright spec finds exactly one ad wrapper on `/browse/best-musicals` and zero on a list with fewer than 10 items

### Task S2-T5: Playwright spec for ad rules
- **Complexity:** M
- **Depends on:** S2-T3, S2-T4
- **Parallel:** No
- **Files:** `tests/e2e/ads.spec.ts` (new)
- **Description:** Run against a flag-on preview (`TEST_BASE_URL`), on the `chromium` and `mobile` projects. Assert:
  - excluded routes have no `.adsbygoogle` and no `adsbygoogle.js` request
  - show and browse pages have exactly one wrapper with the expected `min-height`
  - the distance rule from S2-T3 holds
  - the page has no horizontal overflow
  - a stubbed signed-in session has no wrapper

  Block the real ad script with `page.route` so the test never generates ad impressions. **That matters: fake impressions from test runs count as invalid traffic in AdSense.**

  Land the spec advisory first per CLAUDE.md §19 (`continue-on-error: true` if it is wired into CI).
- **Acceptance criteria:**
  - VERIFY: `npx playwright test tests/e2e/ads.spec.ts` passes against the preview

### Task S2-T6: Unit test for route eligibility
- **Complexity:** S
- **Depends on:** S1-T1
- **Parallel:** Yes
- **Files:** `tests/unit/ads-eligibility.test.ts` (new; same style as `robots-api-disallow.test.ts`)
- **Description:** Import the real `isAdEligiblePath` (CLAUDE.md §15: never copy logic into tests). Cover every excluded route family from S1-T1, West End show slugs, trailing slashes, query strings and an unknown future route (must default to false).
- **Acceptance criteria:**
  - VERIFY: the unit test passes with at least 20 cases

**Sprint 2 ship:** CLAUDE.md §12 checks, an auth-aware build with `ads` on, `/visual-qa` on show and browse pages, land. The flag stays **off** in production. Also check the page-weight budget spec (`tests/e2e/page-weight-budget.spec.ts`): the ad script is lazy and third-party, so document bytes should barely change.

---

## Sprint 3: Post-approval launch
**Demo:** Ads render in production on show and browse pages for anonymous visitors; UK visitors see Google's consent message; 15% of visitors are a no-ads holdout; China/Hong Kong bot traffic gets a challenge.
**Depends on:** Google approval (after owner Step 1).
**Risks:** (1) Account-level invalid-traffic flags. Mitigation: the bot challenge, never clicking your own ads, and keeping test runs from loading real ads. (2) The env-var flip not deploying, because the deploy gate is content-aware. Mitigation: see S3-T4.

### Task S3-T1: Owner dashboard runbook (agent prepares, owner clicks)
- **Complexity:** S
- **Depends on:** Approval
- **Parallel:** No
- **Files:** none (the agent sends the owner this checklist, then commits the slot IDs to `src/config/ads.ts`)
- **Description:** The owner does this in AdSense, about 15 minutes:
  1. **Ads → By ad unit → Display ads.** Create `bwsc-show-inline` and `bwsc-list-inline`, both responsive. Send the agent the two `data-ad-slot` numbers.
  2. **Ads → By site → broadwayscorecard.com:** confirm **Auto ads is OFF**, which also turns off anchor and vignette (full-screen) formats.
  3. **Privacy & messaging:**
     - Create a **European regulations** message (covers UK, EEA and Switzerland), using Google's certified consent tool, with the site name and the `/privacy` URL.
     - Create a **US state regulations** message targeted at "All current and future supported US states."
     - Publish both.
  4. **Brand safety → Blocking controls → Advertiser URLs:** paste the competing ticket sellers below.
  5. **Brand safety → Sensitive categories:** block Gambling & Betting, Dating, Get Rich Quick, Weight Loss and Cosmetic Procedures. Each block trims revenue slightly; the holdout data will show whether this list matters.
  6. **Account → Access and authorization → Google Analytics integration:** link the GA4 property, so AdSense revenue appears in GA4 for S4-T1.
  7. Payments and tax info can wait until AdSense prompts for it.

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
  TodayTix is intentionally **not** blocked: its ads send buyers to the partner you already earn from.
- **Acceptance criteria:**
  - VERIFY: `AD_SLOTS.showInline` and `AD_SLOTS.listInline` are non-empty numeric strings in `src/config/ads.ts`

### Task S3-T2: Bot challenge in the Vercel firewall
- **Complexity:** S
- **Depends on:** None (can happen any time before launch)
- **Parallel:** Yes
- **Files:** none (Vercel firewall custom rule, applied through the Vercel connector with owner approval, or by the owner in the dashboard)
- **Description:**
  - Add one custom rule: **Challenge** requests whose country is `CN` or `HK`.
  - Evidence: in the 28 days to Oct 22, 2026, PostHog recorded 7,112 sessions from CN/HK/SG with only 26 showing any interaction, against 7,513 engaged US sessions.
  - Use Challenge, not Deny, so the few real visitors can still get through. Leave SG out at first, since it has some real traffic.
  - Run the rule in **Log** mode for 3 days first, then switch it to Challenge.
  - The project has no firewall config today. Hobby allows 3 custom rules, Pro allows 40.
- **Acceptance criteria:**
  - VERIFY: the Vercel firewall config shows the rule active
  - VERIFY: one week later, PostHog CN+HK pageviews drop by at least 80%

### Task S3-T3: No-ads holdout flag
- **Complexity:** M
- **Depends on:** S2-T2
- **Parallel:** Yes (with S3-T1)
- **Files:** `src/components/ads/AdSlot.tsx`; PostHog flag `ads-holdout` created through the API **before** the code (per `docs/experiments/README.md` and `cloud-memory/feedback_ab_test_guardrails.md`)
- **Description:**
  - Create a multivariate flag with variants `ads` (85%) and `no-ads` (15%). Bucket on the person, so a visitor stays in one group.
  - In `AdSlot`, read it the way the repo already does, polling `window.posthog?.getFeatureFlag('ads-holdout')` (the `TicketButtonsAB.tsx:95–125` pattern, every 250ms up to about 5s). The slot is below the fold, so waiting costs nothing.
  - **Fallback:** if PostHog never answers (it is usually blocked by the same ad blockers that block AdSense), treat the visitor as `ads` and do not log exposure.
  - **Reserved box:** keep it in both groups until the flag resolves, then collapse it for `no-ads`. The shift is below the fold.
  - Never delete either variant's code path while the experiment runs.
- **Acceptance criteria:**
  - VERIFY: the PostHog flag exists with an 85/15 split before the code lands
  - VERIFY: on a preview with the flag forced to `no-ads`, no ad wrapper or script loads

### Task S3-T4: Flip the flag in production
- **Complexity:** S
- **Depends on:** S3-T1, S3-T3 landed and deployed; owner "go" (Step 3)
- **Parallel:** No
- **Files:** Vercel production env var `NEXT_PUBLIC_FEATURES` (add `ads`)
- **Description:**
  - Add `ads` to the production `NEXT_PUBLIC_FEATURES` through the Vercel connector, after owner approval.
  - Because it is a `NEXT_PUBLIC_` build-time variable, it only takes effect on the next build. The content-aware deploy gate may not rebuild for an env-only change, but its 6-hour backstop will.
  - If the owner wants it live sooner, land a trivial site-relevant change. Do not hand-dispatch `vercel-deploy.yml` (CLAUDE.md §2).
  - **Rollback:** remove `ads` from the variable, and ads disappear on the next build. `ads.txt` and the meta tag stay up, which is harmless.
- **Acceptance criteria:**
  - VERIFY: `node scripts/check-prod-deploy.js HEAD --wait` exits 0 after the flip
  - VERIFY: a logged-out mobile visit to a show page shows one labeled ad below the reviews; a signed-in visit shows none

---

## Sprint 4: Measurement and the 30-day decision
**Demo:** The Monday traffic email has an "Ads" block. The day-30 report gives a keep/expand/pull recommendation with numbers.
**Risks:** TodayTix commission is paid on a roughly 2-month cycle (actions lock 27 days after month end and pay 20 days later), so paid commission cannot judge a 30-day test. Mitigation: use `ticket_click` events and Impact *tracked actions* (pending and locked), not payouts.

### Task S4-T1: Ad revenue in the weekly traffic email
- **Complexity:** M
- **Depends on:** S3-T1 step 6 (AdSense linked to GA4); GA4 service-account secrets in GitHub (`GA4_SERVICE_ACCOUNT_JSON_B64`, `GA4_PROPERTY_ID`, the same names the owner was given for cloud sessions)
- **Parallel:** Yes (with S4-T2)
- **Files:** `scripts/lib/ga4-ad-revenue.js` (new), `scripts/lib/traffic-report-human.js` (~line 219), `scripts/analyze-traffic-sources.js`, `.github/workflows/analyze-traffic-sources.yml` (add the two secrets to `env:`). The workflow edit is shared infrastructure, so run `/second-opinion` first (CLAUDE.md §18).
- **Description:**
  - Query the GA4 Data API for `totalAdRevenue`, `publisherAdImpressions` and `publisherAdClicks` by week.
  - Join it with PostHog real pageviews (already in `traffic-history.json`) and `ticket_click` counts.
  - Pull Impact tracked actions and commission through the existing `scripts/lib/affiliate-stats.js`.
  - Add an "Ads" block to the email:
    - ad revenue this week
    - ad revenue per 1,000 real pageviews
    - TodayTix clicks per 1,000 pageviews, ads group vs holdout
    - total revenue per 1,000 pageviews (ads + Impact)
  - Persist the weekly numbers in `traffic-history.json` so `/admin/traffic` can chart them later.
  - Degrade gracefully: if the GA4 secrets are missing, print "Ads: not connected" instead of failing the email.
- **Acceptance criteria:**
  - VERIFY: running the report locally with real credentials prints the Ads block with non-null numbers, for at least 3 different weeks of data
  - VERIFY: running it with the GA4 env vars unset still produces the email, showing "not connected"

### Task S4-T2: Guardrail alerts
- **Complexity:** S
- **Depends on:** S3-T4
- **Parallel:** Yes
- **Files:** `scripts/lib/ga4-ad-revenue.js` or the traffic report, plus existing `check-cwv-health.yml` thresholds (no workflow change needed if CLS > 0.1 already alerts)
- **Description:** Flag these in the weekly email's "Keep an eye on" section:
  - (a) TodayTix clicks per 1,000 pageviews in the ads group fall more than 15% below the holdout, over at least 2 weeks and at least 300 clicks per group
  - (b) mobile CLS p75 goes above 0.1 (the existing CWV check)
  - (c) AdSense revenue is $0 for a full week while the flag is on (broken slot or account issue)
- **Acceptance criteria:**
  - VERIFY: a unit test feeds synthetic weekly rows that trip each guardrail and asserts the warning text appears

### Task S4-T3: Day-30 decision report
- **Complexity:** M
- **Depends on:** S4-T1, 30 days after launch
- **Parallel:** No
- **Files:** `scripts/ads-decision-report.js` (new); the output goes to the owner by email via the existing transactional path (`--send-to`, never a broadcast; CLAUDE.md §17)
- **Description:** Compare the ads group and the holdout on:
  - total revenue per 1,000 real pageviews (AdSense + Impact tracked commission)
  - TodayTix click rate, with a confidence interval
  - pages per visit and return-visit rate
  - CLS

  Then recommend one of:
  - **Keep** if total revenue per 1,000 pageviews is at least as high in the ads group and click rate is within 10% of the holdout
  - **Expand** if both hold comfortably: test a second show-page slot after `ShowFAQSection`, behind its own flag
  - **Pull** if TodayTix losses exceed ad income

  Also note when Mediavine Journey becomes worth re-evaluating (sustained ~150k+ real pageviews a month).
- **Acceptance criteria:**
  - VERIFY: the script runs on the real 30 days and prints all four metrics for both groups, with sample sizes

---

## Dependencies Graph
```
Owner Step 0 → S1-T1 → S1-T2 ─┐
               S1-T3 ─────────┤
               S1-T4 ─────────┼→ Sprint 1 lands → Owner Step 1 (Request review) → Google approval
               S1-T5 ─────────┘
S1-T1 → S2-T1 ─┐
S1-T1 → S2-T2 ─┼→ S2-T3 ─┐
               │  S2-T4 ─┼→ S2-T5
S1-T1 → S2-T6  │         │
               └→ S3-T3 ─┤
Google approval → S3-T1 ─┼→ S3-T4 (Owner Step 3) → S4-T2
S3-T2 (any time) ────────┘
S3-T1 step 6 + GA4 secrets → S4-T1 → (30 days) → S4-T3
```

## Subagent Execution Map (within one /execute-plan session)
```
Session A (Sprints 1+2, before approval):
  Subagent track 1:  S1-T1 → S1-T2 → S2-T1 → S2-T2 → S2-T3 → S2-T5
  Subagent track 2:  S1-T3 (privacy) → S1-T5 (robots) → S2-T6
  Subagent track 3:  S1-T4 (CSP) → S2-T4 (after S2-T2 lands in track 1)
  Sync:              ── land Sprint 1 first (unblocks review) ── then Sprint 2 ──
Session B (after approval):  S3-T1 → S3-T3 → S3-T2 → S3-T4
Session C (any time after B): S4-T1 ∥ S4-T2;  S4-T3 at day 30
```
**Parallel sprints:** Sprint 2 code can be written while Sprint 1 awaits deploy, but land Sprint 1 first so the owner can request review as early as possible.
**Critical path:** Step 0 → S1 → Google review (days to weeks, the real bottleneck) → S3 → 30 days → S4-T3.
**Max subagent parallelism:** 3.
**Cross-session plan:** A = Sprints 1+2; B = Sprint 3; C = Sprint 4.

## Known Edge Cases
- **Signed-in hydration shift:** the server renders the reserved box, and the client collapses it for members. It's below the fold, so CLS impact is minimal, but watch `check-cwv-health`.
- **Unfilled ads:** AdSense sometimes returns no ad, especially for UK visitors who decline consent (non-personalized inventory is thinner). The wrapper collapses on `data-ad-status="unfilled"`.
- **Consent banner appears only on ad pages,** because the Google consent message is delivered by the ad script, which loads only on eligible routes. That's fine legally for ads. GA4 and PostHog consent for UK visitors is a separate, pre-existing gap. File it in Linear; it is not blocking here.
- **App Router navigation:** pushing into an already-filled `<ins>` throws "All ins elements already have ads". Keying on `pathname` prevents it.
- **Tests must never load real ads.** The Playwright spec blocks `adsbygoogle.js`, and visual-QA runs on previews should also block it, or AdSense can flag invalid traffic.
- **Owner must never click own ads.** Self-clicks are the most common cause of AdSense suspensions.
- **iOS app:** native (separate repo), so it's unaffected. If any web view in the app loads show pages, it should pass a signal that excludes ads.
- **`/embed/*`** is excluded, so ads never appear inside other sites' embeds.
- **PostHog blocked:** the holdout can't bucket visitors who block PostHog. They default to the ads group and are absent from the comparison. Since AdSense is usually blocked for them too, the comparison stays fair.
- **ISR pages:** show pages revalidate daily, but ad rendering is fully client-side, so slot or flag changes don't wait for ISR. The `NEXT_PUBLIC_FEATURES` change does need a rebuild.
- **CLAUDE.md drift:** CLAUDE.md says "Next.js 14, static export", but the repo runs Next.js 15.5 with ISR and middleware. File a Linear issue to correct it; don't fix it inside this plan.

## Changes from Critique
| Change | Reason | Source |
|---|---|---|
| One ad per page type instead of 2–3 | Lower clutter, protects TodayTix clicks; revenue estimate set at $35–135/month accordingly | Codex comparison |
| AdSense manual units instead of Mediavine Journey | Least owner effort: no application review or support back-and-forth over how ads refresh on Next.js page changes | Owner: "very little effort" |
| Direct sponsorship deferred | Sales and servicing are ongoing owner work | Owner: "very little effort" |
| Privacy policy fix made a launch blocker | `/privacy` currently states the site shows no third-party ads | Codex, verified in `src/app/privacy/page.tsx:152` |
| Holdout group added | Before/after comparison is confounded by Nov–Dec seasonality and openings | Author's own check (`/plan-review` not yet run) |
| Bot challenge for CN/HK | 7,112 bot-like sessions in 28 days; invalid-traffic risk | PostHog query, Oct 22 |
| Vercel Pro check added as Step 0 | Hobby plan bans AdSense explicitly | Vercel fair use guidelines |

## Key Risks
1. **AdSense rejects the site** (for example as "low value content", since show pages are data-heavy). Mitigation: show pages already carry substantial original text (critic summaries, FAQ, quick facts). If rejected, apply again after 2–4 weeks with the editorial guide pages most visible. Mediavine Journey (1,000 premium sessions a month) is the fallback.
2. **Ads reduce TodayTix conversions by more than they earn.** Mitigation: placement far from ticket CTAs, the competitor blocklist, the 15% holdout with a guardrail alert, and a one-variable rollback.
3. **Invalid-traffic action against the account.** Mitigation: the CN/HK challenge, real ads blocked in tests, no self-clicks, and watching AdSense policy-center emails.
