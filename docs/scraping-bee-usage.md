# ScrapingBee credit usage (BRO-2721)

Card filed by the daily health-check ledger (`health-check:Credits: ScrapingBee`):
`46k credits left (5%) · 37k/day burn · exhausts in ~1d (renews Sep 5)`. This
doc is the triage record for that alert — what the numbers actually were when
checked, why no code change was needed, and the standing policy so a future
session doesn't re-litigate "upgrade vs. reduce scraping" from scratch.

## What was checked (2026-09-21)

The card's numbers describe the *end of the prior billing cycle* (renewal was
`Sep 5`, i.e. 2026-09-05) — by the time this card was triaged, that cycle had
already renewed. Live pull from the account API:

```
$ node -e "require('./scripts/lib/check-sb-credits.js').fetchSBCreditStatus().then(s=>console.log(s))"
{
  ok: true,
  maxCredits: 1000000,
  usedCredits: 454233,
  remaining: 545767,
  pctUsed: 45,
  pctRemaining: 55,
  message: 'SB credits: 545767 remaining (55% of 1000000, 45% used)'
}
```

`renewal_subscription_date` from the same API response: `2026-10-05` — 14
days out from the check. At the current burn rate (~28.7k/day, computed the
same way `health-check.js`'s `checkAPICredits` does: `used_api_credit /
daysIntoCycle` against a 30-day cycle estimate), projected exhaustion is
~19 days out — *after* the Oct 5 renewal, not before it. `health-check.js`'s
own verdict at these numbers is `pass` (`pctRemaining <= 5` → error,
`<= 15` → warn, else pass; 55% clears both).

**Conclusion: the alert had already self-resolved via the normal monthly
renewal by the time it reached triage.** No code change was needed — the
condition (`health-check:Credits: ScrapingBee`) does not fire again with
current numbers, and it's designed to clear itself the same way on renewal
going forward.

## Why "upgrade the plan" is not the answer here

This has been asked and answered before, repeatedly enough that it's a
standing memory entry (`feedback_sb_quota_ride_out.md`): **ScrapingBee
exhaustion is ridden out until the billing reset, never escalated as a
DECISION NEEDED about billing.** ScrapingBee is a fallback link in the
scraper chain (Scrapingdog → Bright Data → ScrapingBee → Playwright →
Browserbase), not a dependency — when it's thin, fetches fall through to the
next provider instead of failing outright. Upgrading a fallback provider's
plan to chase a burn rate that self-corrects every 30 days is spend the
owner has explicitly declined in the past.

## Existing architecture (already in place, unchanged by this card)

1. **Per-run credit budgets** cap spend inside a single process:
   `SB_CREDIT_BUDGET` (default 250, `scraper.js`'s `fetchPage()`) and
   `SB_PAGE_CREDIT_BUDGET` (default 200, `collect-review-texts.js`, decision
   logic in `scripts/lib/crt-sb-credit-guard.js`). When a run's budget is
   spent, SB is skipped and the next provider in the chain takes over — a
   graceful degradation, not a failure.
2. **`scripts/lib/check-sb-credits.js`** (`fetchSBCreditStatus`) is the single
   parsed read of the account usage API; `health-check.js`'s
   `checkAPICredits` and the opening-night readiness gate
   (`scripts/lib/sb-credit-verdict.js`) both consume it so the pct/remaining
   math can't drift between the two call sites.
3. **The opening-night readiness gate treats SB exhaustion as a `warn`, not a
   hard `fail`**, up to genuine 0-credits exhaustion — see the rationale in
   `scripts/lib/sb-credit-verdict.js` (`DEFAULT_FAIL_PCT_USED = 100`): a
   demand-aware budget check elsewhere in the same readiness script already
   blocks when *projected* need exceeds what's left, which is the check that
   should actually stop a launch.
4. **`scripts/lib/scrapingbee-ack.js`** — an expiring acknowledgment for a
   *known, already-triaged* exhaustion window, so a real outage doesn't have
   to be re-triaged daily until it clears on its own. Not applied here since
   there's no live exhaustion to acknowledge (see above) — it stays the tool
   for the next cycle if one genuinely runs out early, rather than something
   to pre-emptively set.

## If this alert recurs

1. Re-check live numbers the same way this doc did — the flagged run's
   figures may already be stale by the time a session picks up the card
   (exactly what happened here: `Sep 5` renewal had already passed).
2. If genuinely low (`pctRemaining <= 5` and `remaining > 0`, i.e. real,
   current exhaustion risk before the *next* renewal): this is expected,
   ride-it-out behavior per `feedback_sb_quota_ride_out.md` — confirm the
   per-run budgets above are still in place and doing their job (fallback to
   Bright Data/Playwright, not hard failures), then leave it. Do not raise a
   billing DECISION NEEDED.
3. If credits hit exactly 0 before renewal and the daily alert becomes noise
   for a day or two, use `scrapingbee-ack.js`'s pattern (mirrors the
   ScrapingDog one in `scripts/lib/scrapingdog-ack.js`) to set an expiring
   acknowledgment rather than silently editing the threshold.
4. If the burn rate looks like a genuine anomaly (a new caller spiking spend,
   not steady seasonal use) rather than routine end-of-cycle drawdown, that's
   worth its own investigation — see `feedback_sb_serp_invisible_burn.md` for
   the last time an unlogged code path (`_serpViaScrapingBee` in
   `url-discovery.js`) was the real cause of an unexplained spike.
