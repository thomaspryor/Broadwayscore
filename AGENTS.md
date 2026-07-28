# Broadway Scorecard — Codex Agent Instructions

## Stack
Next.js 14, TypeScript, Tailwind CSS, static export. Production: https://broadwayscorecard.com
2,800+ shows, 19,000+ scored reviews, 490+ outlets, 1,350+ critics (raw counts: `data/shows.json`/`data/reviews.json`).

## Before You Start
Run `npm run data:check` — if data files are missing, stop and report it; do not proceed without data.

## Test Commands (run ALL before committing)
```bash
npx tsc --noEmit          # Zero TypeScript errors
npx next lint             # No new warnings
```
For script changes, run the script against real data (minimum 3 diverse show IDs). `node --check` is syntax only — not a test.

For scoring-logic changes (`scripts/lib/review-guards.js`, `scripts/rebuild-all-reviews.js`, `src/lib/scoring.ts`, `src/lib/engine.ts`, `src/lib/data-core.ts`):
```bash
node scripts/scoring-delta.js
node scripts/test-temporal-override-regression.js
```
Paste the output summary before opening a PR. Do NOT skip this — unit tests passing is not sufficient.

## Data Rules
- **Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.
- `data/shows.json` is the source of truth. `data/reviews.json` is derived (rebuilt by CI).
- Copyrighted review texts live in a private repo (`data/review-texts/`) — never commit them here.
- `git pull` before editing `shows.json` — CI commits to it every ~30 min.

## Design System (for any UI work)
Components live in `src/components/show-cards/` — never create custom versions of existing ones.

**Surface colors:** `bg-surface`, `bg-surface-raised`, `bg-surface-overlay`, `bg-surface-elevated`
**NEVER use:** `zinc-*`, `slate-*`, or hardcoded dark hex values.

**Score colors:** Always use `getScoreBucket()` from `score-buckets.ts`. Never hardcode tier colors.
**Cards:** Use `.card` / `.card-interactive` / `.card-premium` CSS classes only.
**Branding:** `src/config/branding.ts` is the single source of truth. Never hardcode brand colors.

Score badge size/position is sacred — never change it. Score column: `w-20 sm:w-24`.

## Scoring
- Composite = tier-weighted average: T1 (NYT, Vulture, Variety) = 1.0 | T2 (TheaterMania, NY Post) = 0.75 | T3 (blogs) = 0.35
- `compositeScore` = critic-only (browse/homepage). `blendedScore` = 50/50 critic+audience (Tony predictions).
- Stars are ground truth — never cap a star score with an LLM estimate.

## Web Scraping
All scraping scripts MUST use `fetchPage()` from `scripts/lib/scraper.js` — never call Bright Data or ScrapingBee APIs directly.
Workflows that scrape must pass both `BRIGHTDATA_TOKEN` AND `SCRAPINGBEE_API_KEY`.

## Test Extraction Pattern
Never copy logic into test files. Extract pure functions to `scripts/lib/` and `require()` them.
Tests must be `.mjs` using the `node:test` API — Jest is not installed.

## Email Safety (NO EXCEPTIONS)
- Never call `POST /broadcasts/{id}/send` directly — only via `send-opening-night-broadcast.js`.
- Never send to a Resend audience with >5 real contacts for any test or validation purpose.

## Deployment
Git-triggered builds are blocked. Deploys happen only via the `vercel-deploy.yml` workflow.
To trigger manually: `gh workflow run "Deploy to Vercel"`.

## Key Files
- **App logic:** `src/lib/engine.ts`, `src/lib/data-core.ts`, `src/lib/scoring.ts`
- **UI:** `src/components/show-cards/` (shared), `src/app/` (routes)
- **Scripts:** `scripts/gather-reviews.js`, `scripts/rebuild-all-reviews.js`, `scripts/validate-data.js`
- **Config:** `src/config/commercial.ts` (commercial), `src/config/branding.ts` (brand colors)

## Commercial Section (`/biz`)
Never mark `recouped: true` without a citation.
