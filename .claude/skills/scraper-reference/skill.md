---
name: scraper-reference
version: "1.0.0"
description: "AUTO-LOAD when: user asks about scraping, fetchPage, ScrapingBee, Bright Data, Playwright scraping, adding a new scraper, migrating a fetch call, debugging a 403 or empty response, Cloudflare blocking, paywall cookies, or any script that uses scripts/lib/scraper.js. Contains gotchas, fallback chain, and architecture rules for this project's scraping infrastructure."
allowed-tools: Bash, Read
user-invocable: true
---

# Broadway Scorecard Scraper Reference

This skill contains everything you need to know about scraping in this project. Read the relevant section before writing any scraping code or diagnosing a scraping failure.

## Contents

- `references/gotchas.md` — Documented failure modes and fixes (READ FIRST)
- `references/fallback-chain.md` — The BD → SB → Playwright → Browserbase tier chain
- `references/cookies.md` — Paywall cookie setup and management (local-only / gitignored; cloud sessions won't have it — ask the user if needed)

## The One Rule

**All scraping MUST go through `fetchPage()` from `scripts/lib/scraper.js`** — never call Bright Data or ScrapingBee APIs directly. Workflows using fetchPage must pass `BRIGHTDATA_TOKEN` and `SCRAPINGBEE_API_KEY` env vars. CI enforces this.

Exception: WP API JSON calls use `fetchJSON()` from the same file. Google SERP uses `serpQuery()` from `scripts/lib/url-discovery.js`.

## Quick Diagnosis

| Symptom | First thing to check |
|---------|---------------------|
| 0 results after migration | Did you unwrap `result.content`? fetchPage returns `{content, format, source}` not a string |
| 403 from site | See fallback-chain.md — which tier is failing? |
| BD returns empty 200 | Check `result.content.length > 0` guard. theatre.reviews does this. |
| Playwright renders 404 as success | Validate content markers, not just length |
| Cloudflare "Just a moment..." | Only Browserbase works — see fallback-chain.md |
| Missing credits / 402 | Check SB_CREDIT_BUDGET env var. Override to 1000 for bulk runs. |
| Paywall outlet breaking | Cookie-only auth — refresh via Safari export, never email/password (host + cookie set in cookies.md, local-only) |

Read `references/gotchas.md` for the full documented list.
