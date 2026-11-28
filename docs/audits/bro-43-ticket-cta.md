# BRO-43: show-page ticket CTA audit

Audit date: 2026-10-25. Scope: Hamilton, Wicked, The Lost Boys and the
2026 Broadway production of Death of a Salesman.

## Finding and decision

The purchase CTA is `TicketButtonsAB`, rendered by the redesigned hero and
the legacy show header. Its current behavior does not reproduce a missing
CTA on the three open shows. Keep the current single purchase button and
consolidate its surrounding status messages into `ShowPageTicketCTA.jsx`,
used by both layouts. This gives the purchase area one implementation for
future changes without changing seller choice, appearance or attribution.

The card's required component was absent on main. Adding an unused file
would not address that: both layouts now render the named component.
The refactor delegates to the existing `TicketButtonsAB` and `TicketLink`.

## Evidence and limits

The card reports May 1-22 click/pageview ratios: Salesman 33/603 = 5.47%;
Hamilton 21/2,309 = 0.91%. This is click-through, not completed purchases.
Wicked and The Lost Boys were absent from a top-30 click list. Their exact
counts are unknown; that absence cannot be treated as zero.

Current local catalog and server rendering:

| Production | Current status | First-paint CTA | After extraction |
| --- | --- | --- | --- |
| Hamilton (2015) | Open | Get Tickets from $112, TodayTix | Identical |
| Wicked (2003) | Open | Get Tickets from $89, TodayTix | Identical |
| The Lost Boys (2026) | Open | Get Tickets from $58, TodayTix | Identical |
| Death of a Salesman (2026) | Closed | Closed-show explanation, no purchase link | Identical |

Across all 3,956 catalog records, the real CTA and note path using stored
ticket links produced identical HTML before and after in both inline and
split layouts: zero records changed. This comparison does not render full
pages or enrich tour-stop links. It uses current catalog inputs, not
reconstructed May records or live availability checks. No private data was edited.

Existing fixes already present on main:

- `TicketButtonsAB.tsx` renders immediately, before PostHog flags resolve.
  Its comments identify an earlier render gate that could hide the CTA for
  five seconds. This is a plausible historical mechanism, not proof of the
  May gap's cause.
- The single-button experiment concluded on 2026-09-16. The owner chose
  the single CTA after no significant user-level difference was found.
  See [the experiment conclusion](../experiments/ticket-single-button.md#conclusion-2026-09-16).
- Official-site fallback, sole-seller fallback and explicit closed/not-on-sale
  explanations already exist. Preserve them, along with the platform flag.

`HEAD` and `origin/main` were the same commit during the audit, and the
card's file-presence check failed there. The requested `git log -S
'ShowPageTicketCTA' --oneline -5` history search could not complete because
this partial clone lacks older objects and its shared object store is read-only.
The current-main findings above come from the checked-out source and rendering.

## Writers and callers

- `scripts/enrich-todaytix-data.js` writes TodayTix links;
  `scripts/enrich-ticket-prices.js` fills their prices.
- `src/app/show/[slug]/page.tsx` prepares links through `sortTicketLinks`
  and passes them to the hero; tours may use the existing stop-link fallback.
- Both the legacy header and `src/components/show-page/ShowHeroRedesign.tsx`
  call `src/components/ShowPageTicketCTA.jsx`.
- `TicketButtonsAB.tsx` selects the primary seller; `TicketLink.tsx`
  builds affiliate links and emits click events. `src/lib/affiliate-utils.ts`
  owns the shared PostHog beacon writer.
- Vercel and PostHog use `ticket_click`; GA4 uses `ticket_link_click`.
  A PostHog query for the GA4 event name would miss these clicks.

## Measurement and modification plan

1. Pull the complete May 1-22 report for the four exact production IDs,
   including the year and timezone of the original report. Use one analytics
   source for both clicks and pageviews, `page_type=show` on clicks, matching
   show paths on pageviews, the same date boundaries and bot filters.
   Retrieve all four counts explicitly, without a top-N cutoff. Split by
   device, referrer and experiment cohort before comparing intent.
2. Repeat for a fixed 28-day window after the latest CTA deployment, using
   productions that are open in that window. Salesman's current closed
   state makes it unsuitable as a current purchase comparator. Separately
   examine user-level Impact purchases/commission through existing click
   attribution; do not label click-through as purchase conversion.
3. If links are unavailable or the CTA fails to render, fix that reproducible
   defect in the existing writer or shared component. If the residual gap
   is behavioral, propose a fresh, pre-registered copy experiment: compare
   the current label with "Check dates & tickets", retaining any displayed
   starting price and the same seller destination. Use click-through as a
   diagnostic and user-level purchase/commission as a business guardrail. Choose the sample
   size and detectable effect before launch; do not reopen the retired
   button-count experiment or change platform rollout without owner approval.

The code audit and consolidation are complete. Historical counts, causal
attribution and conversion uplift remain unverified. No analytics API pull
or new experiment was performed by this change.

## Verification and cost

- Acceptance: `test -f src/components/ShowPageTicketCTA.jsx`.
- Runtime regressions: `node --test --test-timeout 300000 tests/unit/show-page-ticket-cta.test.mjs tests/unit/show-page-rage-clicks.test.mjs tests/unit/ticket-buttons-single-only.test.mjs tests/unit/show-page-hero-legacy-parity.test.mjs`.
- The runtime tests require the real component, seller selection and affiliate
  helpers. They cover first paint without an SDK, both layouts, closed shows,
  unpriced announcements, official-only and sole-seller fallback, resale-only
  suppression and the standalone lottery pill.
- Additional paid fetches, LLM calls and API calls per render/run: zero.
  No cron, workflow or analytics event was added.

Verification completed 2026-10-26:

- Acceptance failed on the starting main checkout and passes with this diff.
- Related Node tests: 136 passed, zero failed. Related TSX tests: 80 passed,
  zero failed. Exact commands are below.
- `npx tsc --noEmit`: passed after the existing build preflight generated
  the initially absent cast and actor slug manifests.
- `npx next lint`: passed with existing repository warnings. The targeted
  command below reported no warnings or errors in the changed source files.
- The production build command below passed, generating 2,638 pages.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  the gate reported only `actionlint: command not found`; all other audits
  passed. Read `/tmp/gauntlet/lint-workflows.log` to confirm the failure list.
- A temporary Chromium fixture rendered the actual component with current
  catalog records and compiled site CSS at 360, 390, 768, 1024 and 1440px.
  Every viewport had three purchase anchors and no horizontal overflow.
  All five screenshots were inspected. This is component-level visual QA,
  not a full-page or production check.
- Restored 113 unrelated generated tracked files after the build. Git's
  checkout command could not write the read-only index, so the same HEAD
  blobs were restored directly to those worktree paths. Scratch scripts,
  screenshots and logs were removed after verification.

```sh
node --test --test-timeout 300000 \
  scripts/lib/notion-migrated-sweep.test.mjs \
  scripts/lib/reddit-post-screenshots.test.mjs \
  scripts/lib/score-tier-label-contract.test.mjs \
  scripts/validate-schema-removal.test.mjs \
  tests/unit/diary-grid-delete-affordance.test.mjs \
  tests/unit/isr-config.test.mjs tests/unit/replay-masking.test.mjs \
  tests/unit/show-page-hero-legacy-parity.test.mjs \
  tests/unit/show-page-no-csr-bailout.test.mjs \
  tests/unit/show-page-ob-venue-link-parity.test.mjs \
  tests/unit/show-page-rage-clicks.test.mjs \
  tests/unit/show-page-ticket-cta.test.mjs \
  tests/unit/show-trust-lines-parity.test.mjs \
  tests/unit/ticket-buttons-single-only.test.mjs \
  tests/unit/ticket-click-provider-agnostic.test.mjs \
  tests/unit/ugc-copy-no-em-dash.test.mjs \
  tests/unit/visual-qa-flag-awareness.test.mjs \
  tests/unit/watchlist-plan-card.test.mjs

node --import tsx --test --test-timeout 300000 \
  tests/unit/HoverRateStars.test.mjs tests/unit/browse-slugs.test.mjs \
  tests/unit/mobile-feed-website-parity.test.ts \
  tests/unit/show-date-line-parity.test.mjs \
  tests/unit/uk-regional-placement.test.mjs \
  tests/unit/want-to-see-button.test.mjs \
  tests/unit/ticket-click-tracking.test.ts \
  tests/unit/ticket-links-hidden-fallback.test.ts

npx next lint --file src/components/ShowPageTicketCTA.jsx \
  --file src/components/show-page/ShowHeroRedesign.tsx \
  --file 'src/app/show/[slug]/page.tsx'

SKIP_HEAVY_PREBUILD=true \
NEXT_PUBLIC_SANITY_PROJECT_ID=fp1ft8k8 \
NEXT_PUBLIC_SANITY_DATASET=production \
NEXT_PUBLIC_FEATURES=criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions \
npm run build
```
