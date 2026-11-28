# Experiment: ads

Setup contract for any new experiment: [`README.md`](./README.md).
Plan: `sprint-plan-adsense.md` (BRO-5893).

## What's being tested

Does one fixed 300×250 Google AdSense unit on show pages (below the Critic
Scorecard, far from ticket buttons) earn more than it costs in TodayTix/Impact
commission?

- **Flag key**: `ads` (PostHog, project 332742, flag id 983957)
- **Variants**: `ads` / `no-ads`, 100% release rollout,
  `ensure_experience_continuity: false` (ads only render for signed-out
  visitors, so the test is anonymous-only)
- **State today**: pre-launch, **0% `ads` / 100% `no-ads`**. `ADSENSE_CLIENT`
  and the `showInline` slot id are committed in `src/lib/ads.ts`, so the flag
  is the only switch: nobody sees an ad or loads the Google script until it
  moves off 0%.
- **At launch**: eligible visitors already log `no-ads` exposures
  (`$feature_flag_called`) while the flag sits at 0%, so count the 4 weeks
  (and set any PostHog experiment's start date) from the moment it moves to
  50/50, not from when the code shipped.
- **Client**: `src/components/ads/AdSlot.tsx` via `usePostHogFlag(ADS_FLAG)`;
  decision in `decideAdRender()` (`src/lib/ads.ts`)
- **Registry entry**: `scripts/lib/flag-registry.js` (`REGISTERED_FLAGS`)
- **Who never sees ads, whatever the flag says**: signed-in members, visitors
  while auth is still loading, the UK/EEA/CH (`bwsc_ad_region` cookie from
  `src/middleware.ts`), automated browsers, `?noads=1` / `bwsc_noads=1`, and
  anyone whose PostHog doesn't resolve the flag.

## Hypothesis

Total revenue per 1,000 real show-page pageviews (AdSense + Impact commission,
minus a Vercel Pro upgrade if one was needed) is higher in `ads` than in
`no-ads`, without a meaningful drop in ticket-click rate.

## Metrics

- **Primary (owner-agreed)**: total revenue per 1,000 real pageviews, per arm.
  AdSense earnings are entered by hand from the dashboard
  (`--adsense=<dollars>`); Impact uses tracked actions joined by
  `subId1`/distinct_id (not paid commission, which lags ~2 months; `subId2` is
  taken by the ticket-button test).
- **Secondary**: `ticket_click` per 1,000 show-page pageviews per arm, with a
  95% confidence interval. Join on `$feature/ads`; only count people who
  resolved the flag.
- **Guardrail**: CLS p75 from `check-cwv-health`; AdSense impressions vs
  PostHog `ad_slot_rendered` (a large gap suggests invalid traffic).

## Duration

4 weeks at 50/50 from the owner's "go". Readout: `scripts/analyze-ads-test.js`
(B-T8, one-off; written when the test ends). Decide these rules now, before
looking at any data.

## End states

- **Keep**: set the flag to 100% `ads`; the flag stays as the kill switch.
  Update the registry split.
- **Pull**: set the flag to 0% `ads`, then remove `AdSlot`, `src/lib/ads.ts`,
  `src/app/ads.txt`, the `google-adsense-account` meta tag, the flag-registry
  entry, the middleware region cookie and the firewall rule.
- **Run 4 more weeks** if the confidence interval straddles the threshold.

**Kill switch at any time**: set the flag to 100% `no-ads`. It takes effect on
the next page load with no rebuild.
