# Scraper Fallback Chain

## The Tier Chain (in order)

```
Tier 0:   Direct fetch (no proxy) — for non-blocked sites
Tier 0.5: ScrapingDog — cheap primary (~$0.09-0.45/1k), tried BEFORE Bright Data
Tier 1:   Bright Data web_unlocker — handles hard sites SD can't (~$1.50/1k)
Tier 2:   ScrapingBee — fallback when BD fails
Tier 3:   Playwright (headless Chrome) — for JS-heavy sites
Tier 1.5: Browserbase — Cloudflare-protected sites ONLY
```

## ScrapingDog (the cheap primary since 2026-06)

- Default ON (`SCRAPER_USE_SCRAPINGDOG=0` to opt out). Key is GH-secrets-only, not in local .env.
- **Billing: prepaid monthly plan** (~1M credits/cycle, credits EXPIRE at renewal — not PAYG). Plain fetch = 1 credit, dynamic/premium = 5-10, Google SERP = 5.
- SERP also goes SD-first (`_serpViaScrapingdog` in url-discovery.js, Google Light Search).
- **Daily breaker ceiling is plan-derived (BRO-2943, 2026-09-07):** `check-sd-breaker.js` sets the ceiling to (pack credits left at day start ÷ days to renewal) × 1.5, clamped to what is left, minus the 3,000/show opening-window reserve. `SD_BREAKER_CEILING` env pins it; the old 45,000 default applies only when `/account` is unreachable or lacks `requestLimit`/`validity` (the checker warns when that happens); `SD_BREAKER_BURST_FACTOR` tunes the 1.5x. Both knobs are sourced from repo *variables* in `commercial-rss-poll.yml` (`gh variable set SD_BREAKER_CEILING --body N` is the no-commit emergency pin). The hardcoded 45K tripped by mid-morning most days against ~50K/day demand and rerouted routine SERP/page traffic to Bright Data (17x) + ScrapingBee SERP (25 credits vs SD's 5) — that was the whole ScrapingBee "92% of cap" overspend. State file `data/audit/sd-circuit-breaker.json` carries `ceilingSource: env|plan|default`.
- Quota breaker (`shouldSkipScrapingdogAtRuntime` in scrapingdog-ack.js) trips ONLY on actual exhaustion. NEVER re-add pace-projection routing — prepaid credits must be drained before BD's 17x cost (2026-07-26 $50 BD recharge incident). Mid-run exhaustion latches via 401/403/429 from the scrape endpoint.
- SD HTTP 400 = "host needs premium/stealth" (fetchJSON escalates); it is NOT a quota signal.

## When Each Tier Is Used

| Site type | Tier chain |
|-----------|-----------|
| Standard sites | Tier 0 → 1 → 2 → 3 |
| JS-required (render needed) | Tier 2 (SB, render_js=true) → 3 |
| Cloudflare protected | Tier 1.5 (Browserbase) only |
| Paywalled (cookies needed) | Tier 2 with premium_proxy + cookie forwarding |

## Special Domains

**JS_REQUIRED_DOMAINS** (render_js=true in SB): defined in `scripts/lib/scraper.js`
- These use SB at 5 credits/call instead of 1

**PLAYWRIGHT_FIRST_DOMAINS**: defined in `scripts/lib/scraper.js`
- Skip BD entirely, go straight to Playwright

**CONFIG.knownBlockedSites** in `scripts/collect-review-texts.js`:
- Routes to Browserbase (Tier 1.5) for Cloudflare-managed-challenge sites
- Adding here is required for Browserbase routing — it doesn't happen automatically

**Weekly grosses / all-time grosses:**
- These scripts use SB → Playwright (not BD first)
- BD (raw HTML) can't replace SB for JS-rendered pages
- Do NOT add BD to `weekly-grosses.yml` or `scrape-alltime-grosses.yml`

## Costs: never write a rate or a credit count inline

Two tables, deliberately separate lifecycles. Nothing anywhere else in the repo
may hold its own copy of either — that is what let the Bright Data rate sit at
`0.001` in the weekly cost report while the real rate was `0.0015`, a 50%
under-report nobody caught because four files each "kept in sync" by comment.

**`scripts/lib/provider-credits.js` — how many credits one call bills.** The
provider's API contract; changes only when a provider ships a new tier.

```js
const { creditsFor, assertFiniteCost } = require('./lib/provider-credits');
creditsFor('sd', 'render');       // 5
creditsFor('sb', 'stealth_proxy'); // 75
creditsFor('sb', 'typo');          // THROWS
```

`creditsFor` **throws on an unknown (provider, mode) pair** rather than
returning `undefined`, and that is the whole point. `undefined` credits make
`spent + credits > budget` evaluate to `NaN > budget`, which is `false` — so a
silent miss does not merely mis-report a cost, it *disables the spend guard*
and the run bills without a ceiling. Same reasoning for `assertFiniteCost(n,
label)`: use it on every value that reaches a budget comparison or a running
total, including the budget itself (a malformed `SB_PAGE_CREDIT_BUDGET=abc` is
`NaN` and fails open exactly the same way). A guard that fails open is worse
than no guard, because the operator believes it is holding.

Modes are the LITERAL strings the call sites already hold — `sb` carries both
`page/render/premium` (scraper.js) and `standard/premium_proxy/stealth_proxy`
(collect-review-texts.js, where the value is also a real ScrapingBee API
param). Never invent an alias.

**`scripts/config/provider-pricing.json` — what a credit costs in USD.** Plan
economics; the owner can renegotiate any time. Read it only through
`scripts/lib/provider-pricing.js`:

```js
const { usdFor } = require('./lib/provider-pricing');
usdFor('brightdata', requests);                          // per-request rate
usdFor('scrapingdog', credits);                          // prepaid plan rate
usdFor('scrapingdog', credits, undefined, { billing: 'payg' }); // PAYG add-on rate
```

`usdFor` throws on an unpriced provider or an unknown `billing` mode instead of
multiplying by `undefined` and printing `$NaN`. Shell callers (e.g.
`scraper-cost-report.yml`) read the JSON through a `node -e` one-liner and
validate the result before handing it to `bc` — never a literal in the YAML.

Consumers today: `scraper.js` (the `[Scraper Summary]` line),
`measure-scraper-usage.js`, `scrapingdog-bakeoff.js`,
`evaluate-brightdata-serp.js`, `url-discovery.js` (SERP credits),
`collect-review-texts.js` (via the budget guard below), and
`scraper-cost-report.yml`.

## Budget guards

`scripts/lib/crt-sb-credit-guard.js` holds `collect-review-texts.js`'s per-run
ScrapingBee page-credit decision — extracted so the test exercises the real
function (CLAUDE.md §15), not a copy:

```js
const { sbPageBudgetDecision } = require('./lib/crt-sb-credit-guard');
const { credits, exhausted } = sbPageBudgetDecision({
  spentCredits: stats.scrapingBeePageCredits,
  mode: proxyType,              // unknown proxyType throws
  budget: SB_PAGE_CREDIT_BUDGET, // NaN budget throws
});
```

Boundary semantics match the comparison it replaced: `projected === budget` is
allowed, one credit more is not.

## Chain order is a pure function, and it is tested

`pageChainOrder(flags)` (exported from `scripts/lib/scraper.js`) and
`serpChainOrder(...)` (from `scripts/lib/url-discovery.js`) return the ordered
tier names for a fetch — `['scrapingdog', 'brightdata', 'scrapingbee',
'playwright-last']` and so on. They decide ORDER ONLY: whether a key, budget,
quota or breaker check passes is computed by the caller and handed in as flags,
and each tier re-checks its own budget internally. Extracting the order this
way is what makes the ordering testable without a network call.

`scripts/lib/chain-escalation.test.mjs` walks both chains and prices every
consecutive pair through `creditsFor` + `usdFor`. A step that gets **more
expensive** must be declared in that file with a stated reason; an undeclared
cost increase fails the test. That is the mechanism that makes a silent
backwards-cost fallback structurally impossible rather than something a human
might spot in a log. Reordering a chain means updating that file's declarations
in the same commit — if you cannot write down why the pricier tier comes next,
that is the test telling you something.

`scripts/lib/page-chain-order.test.mjs` and `serp-chain-order.test.mjs` pin the
orders themselves against enumerated flag combinations.

## Why a tier ran: `fallback_from`

Every spend-ledger row (`data/audit/scraper-spend-ledger.jsonl`) carries
`fallback_from` — the tier that failed, or was breaker-blocked, immediately
before this one. `fetchPage` threads it through the chain via
`fallbackFromLabel()` in `scripts/lib/fallback-attribution.js`, using
`pageChainOrder`'s own tier names, plus one special value: **`'sd-breaker'`**
when Scrapingdog was never attempted because its daily circuit breaker was
shut. "Never attempted, the day cap was closed" and "attempted and missed" are
opposite cost stories, and the ledger has to tell them apart to explain a
Bright Data spike. This is telemetry only — nothing routes on it.

## The Architecture Rule

```js
// CORRECT — use the lib
const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');

// WRONG — never call directly
const response = await fetch(`https://app.scrapingbee.com/api/v1?...`);
const response = await fetch(`https://api.brightdata.com/...`);
```

## Workflow Requirements

Any workflow step using a script that calls fetchPage must include:
```yaml
env:
  BRIGHTDATA_TOKEN: ${{ secrets.BRIGHTDATA_TOKEN }}
  SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
```

CI lint enforces this (`lint-workflows` job in `test.yml`). Exempt list is in `test.yml` with comments — only add to exempt list if the workflow genuinely doesn't scrape (health checks, credential validators, etc.).

## Diagnosing Which Tier Is Failing

Add `--verbose` or check `result.source` in fetchPage return:
```js
const result = await fetchPage(url);
console.log('Fetched via:', result.source); // 'brightdata', 'scrapingbee', 'playwright', 'browserbase', 'direct'
```

If all tiers fail:
1. Check if site added Cloudflare managed challenge recently → needs Browserbase
2. Check BD zone status: `curl https://api.brightdata.com/zone?zone=$BRIGHTDATA_ZONE -H "Authorization: Bearer $BRIGHTDATA_TOKEN"`
3. Check SB credits remaining: `curl https://app.scrapingbee.com/api/v1/usage?api_key=$SCRAPINGBEE_API_KEY`
