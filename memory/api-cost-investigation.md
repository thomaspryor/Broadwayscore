# Model API cost investigation (BRO-7517, 2026-11-18)

Scope: pay-per-token model APIs (OpenAI, Google Gemini, Anthropic API key). Excludes
subscriptions (Claude Code / Max, ChatGPT login used by the Codex runner). Scraper
vendors are out of scope except where noted. No code was changed.

## TL;DR
- Only two real bills exist in the repo: **Oct 2026 OpenAI ~$580, Google ~$900+**
  (owner-reported, `data/audit/llm-vendor-receipts.json`). No Anthropic invoice is recorded.
- Our own meter explains almost none of October: `node scripts/reconcile-llm-spend.js`
  (run 2026-11-18) prints `gemini: ledger $19.18 vs receipt $900 (98% unexplained)` and
  `openai: ledger $0.00 vs receipt $580 (100% unexplained)`. The meter only started
  2026-10-22 (Gemini), 2026-11-09 (OpenAI), 2026-11-15 (Anthropic), and before BRO-7521
  many workflows never committed their rows.
- With metering now wired, the last 7 full days (2026-11-11..17) run at roughly
  **OpenAI $13/day (~$390/mo), Gemini $4.6/day (~$140/mo), Anthropic ~$15/day (~$450/mo,
  3 days of data)**. That puts current OpenAI near the October bill once the one-off
  scoring experiment is removed (~$280/mo), but Gemini is ~$760/mo short of the Google bill.
- Biggest single lever: the scoring ensemble still runs **gpt-4o-2024-08-06** ($2.50/$10 per
  MTok). Its cheaper replacement (gpt-5.6-luna, $0.20/$1.20) is already in shadow A/B and
  passing the rule-13 bucket/mean gates.

## 1. Sources used (and what is NOT reachable)
| Source | What it holds | Range |
|---|---|---|
| `data/audit/gemini-usage-ledger.jsonl` (3,643 rows) | Per-process token + est. cost rows for Gemini, OpenAI (since 11-09), Anthropic (since 11-15). Written by `scripts/lib/gemini-usage-ledger.js` (fetch wrapper, list prices, batch at 50%, grounding at $0.035/call, thinking tokens counted as output) | 2026-10-22 .. 2026-11-18 |
| `data/audit/provider-spend-daily.jsonl` `llmScoring` field | LLM ensemble scoring cost per day (from `scripts/llm-scoring/cost.ts` via `scripts/lib/llm-scoring-cost-recording.js`); 11-09..14 are a git-history backfill (BRO-7576) | 2026-11-09 .. 2026-11-17 |
| `data/audit/provider-spend-snapshot.json` | Daily digest line "LLM APIs (metered estimate, not the full bill)" | 2026-11-17 |
| `data/audit/llm-vendor-receipts.json` | Owner-reported invoices | 2026-10 only |
| `data/audit/claude-session-cost.jsonl` | Claude cloud-session cost (cumulative per session, `get_session`), only sessions that landed commits | 2026-10-29 .. 2026-11-18 |
| `data/audit/ccusage-monthly.json` | One-off ccusage export of Claude Code usage at list-price equivalent | 2026-03 .. 2026-10 |

**Not reachable from this machine:** OpenAI Usage/Costs API (needs an admin key; only
`OPENAI_API_KEY` is set), Google Cloud Billing / BigQuery billing export (`gcloud auth list`:
no credentialed accounts), Anthropic Console usage/cost API (no admin key; no Anthropic
invoice in receipts). Every monthly figure below that is not a receipt is a **list-price
estimate from token counts**, not a bill.

## 2. Actual spend figures
**Invoices (owner-reported, approx):** 2026-10 OpenAI $580; 2026-10 Google $900+ (floor).

**Metered estimate per day** (`gemini-usage-ledger.jsonl`, USD):

| Day | Gemini | OpenAI | Anthropic |
|---|---|---|---|
| 10-22..10-31 total | 19.18 | (not metered) | (not metered) |
| 11-01..11-08 total | 1.50 | (not metered) | (not metered) |
| 11-09 | 3.82 | 3.73 | - |
| 11-10 | 6.01 | 36.37 | - |
| 11-11 | 0.81 | 2.46 | - |
| 11-12 | 4.32 | 27.58 | - |
| 11-13 | 3.99 | 25.47 | - |
| 11-14 | 0.47 | 8.66 | - |
| 11-15 | 9.36 | 19.78 | 3.90 (partial) |
| 11-16 | 6.65 | 2.28 | 19.56 |
| 11-17 | 6.71 | 5.28 | 14.26 |
| 11-18 (partial) | 1.39 | 0.45 | 11.44 |

**LLM scoring (all three vendors) per day** (`provider-spend-daily.jsonl` `llmScoring`):
11-09 $12.63, 11-10 $4.57, 11-11 $5.35, **11-12 $47.62, 11-13 $63.60** (rescore chain),
11-14 $3.71, 11-15 $3.59, 11-16 $2.26, 11-17 $1.73. Total 9 days $145.06.

**Claude subscription-side (not API bills, context only):** `claude-session-cost.jsonl`
176 landed-commit sessions 10-29..11-18, lifetime sum $3,865 list-price equivalent.
`ccusage-monthly.json` shows Claude Code at $25k (Jul) / $31k (Aug) / $16k (Sep) list-price
equivalent. These are subscription usage meters, not invoices; if any of it is in fact
billed to an API key, that would dwarf everything else here and is worth one check of the
Anthropic Console by the owner.

## 3. Inventory: who calls the APIs (metered 2026-11-11..18, 8 days; monthly = x3.75)
129 non-test files under `scripts/`, `src/`, `supabase/` call a model API; 100 workflows
hold a model secret (ANTHROPIC 104 refs, OPENAI 81, GEMINI 77). No Vertex AI calls (only
`vertexaisearch` grounding redirect URLs). Ranked by metered cost:

| Workflow (schedule) | Script | Models | 8-day $ | ~$/mo |
|---|---|---|---|---|
| LLM Ensemble Score Reviews (`llm-ensemble-score.yml`, 04:30 + 10:30 cron, plus batch every 6h and chain re-dispatch: 529 runs in 8 days) | `scripts/llm-scoring/index.ts`, `comparative-rescore.ts` | gpt-4o-2024-08-06 ($52.5), claude-sonnet-4-6 / sonnet-5-5 / haiku-4-5 ($11), gemini-2.5-flash ($9.2) | 72.75 | ~270 (spikes to $60/day on rescore chains) |
| Scoring Experiment (`scoring-experiment.yml`, manual) | `scripts/llm-scoring/openai-leg-shadow.ts` | gpt-4o + gpt-5.6-luna / gpt-6-luna shadow, gemini-2.5-flash | 28.79 | one-off (BRO-7341 A/B) |
| Collect Review Texts (04:30/10:30/18:30) + WE/OB (08:00) + Opening Night Poller | `scripts/collect-review-texts.js` | claude-haiku-4-5 ($18.2), gemini-2.5-flash ($1.2) | 17.2 | ~65 |
| Commercial Weekly Orchestrator (Sat 18:00) + Deep Research Commercial | `scripts/deep-research-commercial.js` | gpt-5.4-mini with web search (24 calls, $0.33/call) | 8.03 | ~35 |
| Pull quotes: Rebuild Reviews Data (daily 04:00, `--limit=200`, 117 runs) + Extract Pull Quotes (self re-dispatching, 20 runs) | `scripts/extract-pull-quotes.js` | gemini-2.5-flash, 20.6k calls | 11.69 | ~45 |
| Codex card runner (5x/day) | `scripts/codex/daily-runner.js` reviewer `claude -p` | opus via API-key fallback (OAuth token preferred) | 6.37 | ~25 |
| Audit Review Quality (Tue 05:00) | `scripts/audit-city-hub-dual-model.js` | gpt-5.6-terra + gemini-2.5-flash | 5.81 | ~25 |
| Opening Night Poller (event-driven) | llm-scoring + collector | sonnet-5-5, gemini-flash, gpt-5.6-luna | 5.04 | event-driven |
| Weekly Video Reviews (Mon 04:00) | `scripts/video-reviews/*.js` | sonnet-4-6, opus-4-7 | 3.09 | ~13 |
| Daily Data Health Check | `scripts/audit-wrong-article.js`, `scripts/llm-triage.js` | claude-opus-4-7, sonnet-5-5 | 2.93 | ~11 |
| AEO Visibility Weekly (Mon) | `scripts/aeo-visibility-tracker.js` | gemini-2.5-flash grounded + gpt-5.6-luna | 2.63 | ~11 |
| Fetch Show Images / Audit Live Show Art | `fetch-show-images-auto.js`, `audit-live-show-art.js` | gemini-2.5-flash (vision) | 3.43 | ~13 |
| Nightly UX Walkthrough (13:35) | `scripts/ux-walkthrough.mjs` | gemini-2.5-pro, sonnet-5, gpt-4o | 1.43 | ~5 |
| Everything else (~25 workflows: Auto-Maintain, City Finder, Enrich Reviews, Reddit digest, Social Autopost hourly, Process Feedback every 10 min, newsletter, Update Shows, etc.) | various | mostly haiku / flash / sonnet | ~4.5 | ~17 |

Workflows with model secrets that showed **zero** metered cost in the window are manual or
idle (backfills, bulk collectors, plan-review tools). The coverage test
`scripts/tests/usage-ledger-coverage.test.mjs` passes (12/12), so every workflow holding a
model secret now saves its ledger rows.

## 4. Why the bills do not reconcile (hypotheses, unverified)
1. **Metering is new.** October has 10 days of Gemini rows and zero OpenAI rows; BRO-7521
   found eight busy workflows with zero rows in 24 days. October's real usage is simply
   not in the ledger. Current OpenAI run-rate (~$280-390/mo) is in the same order as the
   $580 bill, so OpenAI is probably mostly explained going forward; October also had the
   BRO-7341 / earlier rescore chains at gpt-4o prices.
2. **Google bill is not only Gemini.** The same GCP account may carry Places API
   (`GOOGLE_PLACES_API_KEY`: `generate-theater-tips.yml` quarterly, `scripts/validate-restaurant-names.js`),
   Indexing API, and anything else in that project. Only a GCP billing report (by SKU) can
   split this; not reachable here.
3. **Calls outside CI.** Local Mac runs only land rows when committed (28 `workflow:"local"`
   rows total); other repos or tools sharing the same `GEMINI_API_KEY` / `OPENAI_API_KEY`
   (e.g. `BroadwayScorecard-app/scripts/feedback/web-parity.js`) are invisible.
4. **Grounding free tier / pricing drift.** Grounded calls are costed at $35/1k (upper bound);
   Gemini prices are list prices in `PRICES_PER_M`; a tier or SKU change would skew estimates.

## 5. Ranked savings ideas
| # | Idea | Est. saving | Risk |
|---|---|---|---|
| 1 | **Swap the ensemble OpenAI leg gpt-4o -> gpt-5.6-luna** (BRO-7341). Shadow A/B (`data/audit/openai-leg-ab-report.json`, 1,142 paired reviews) passes bucket-shift (max 4.77pp < 5), mean drift 0.73 and rejection gates; showDrift gate failed only on sample size (2 shows). Token price drops ~92%. | ~$190-230/mo of the ~$200/mo gpt-4o spend at current volume; far more on rescore-chain days ($40+/day) | Medium: Rave share +4.8pp is close to the 5pp gate; finish the per-show check, then flip. Rule 13 A/B already done. |
| 2 | **Route all non-urgent scoring through Batch APIs (50% off)**. In the window only ~$9 of ~$130 scoring/LLM spend was `kind: batch`; most scoring ran synchronously via chain/catch-up dispatches (529 runs). Make rescore chains (`needs_rescore`, `comparative-rescore.ts`) batch-only. | ~$80-130/mo (half of the synchronous ensemble spend; more on rescore-heavy months) | Low-medium: up to 24h latency; keep sync only for opening-night poller/express. |
| 3 | **Stop the Scoring Experiment once BRO-7341 decides** and cap shadow runs to a sample. | ~$29 per 8 days while running (~$100/mo) | Low. |
| 4 | **Collector Haiku calls** (`collect-review-texts.js`, 3,887 calls, ~$18/8d): cache verdicts by text hash (pattern already in `scripts/lib/llm-verdict-cache.js`), and use Anthropic prompt caching for the fixed system prompt; consider gemini-2.5-flash-lite or haiku via batch for the non-opening-night runs. | ~$30-45/mo | Low-medium: classifier quality drift; A/B on a sample first. |
| 5 | **Pull-quote extraction de-dup**: 20.6k Gemini calls in 8 days for a job capped at 200 reviews/run; it runs both inside Rebuild Reviews Data (daily) and the self re-dispatching Extract Pull Quotes workflow. Confirm calls/review ratio (retries?) and keep one entry point; use gemini-2.5-flash-lite or batch. | ~$25-40/mo | Low. |
| 6 | **Opus/Sonnet in audits** (`audit-wrong-article.js` opus-4-7, video reviews opus-4-7/sonnet, `enrich-wikipedia-synopsis.js` opus-4-7): move to Sonnet/Haiku where the task is classification. | ~$15-25/mo | Low-medium. |
| 7 | **Codex reviewer**: make sure `CLAUDE_CODE_OAUTH_TOKEN` is valid so `claude -p` uses the subscription, not the API-key fallback (6 runs cost $6.37). | ~$20-25/mo | Low. |
| 8 | **Get the real bills monthly**: add Nov receipts to `llm-vendor-receipts.json`; ideally an OpenAI admin key and a GCP billing export (SKU level) so `reconcile-llm-spend.js` can split the $900 Google bill. This is the only way to find the ~$700/mo of unexplained Google spend, which may be larger than all ideas above combined. | unknown (potentially the largest) | None (read-only access). |

Approximate total from 1-7 at current volume: **~$400-600/mo**, most of it from #1 and #2.

## Gaps
- No billing API reachable (OpenAI admin, GCP billing, Anthropic Console). All non-receipt
  numbers are list-price estimates from token counts.
- Anthropic metering began 2026-11-15: three days is too short for a stable monthly figure,
  and there is no Anthropic invoice to reconcile against.
- The Google $900 is unexplained by any repo data; SKU split needs the owner's GCP console.
