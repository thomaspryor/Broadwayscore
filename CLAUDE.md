# Broadway Scorecard

## RULES

1. **NEVER ask user to run commands.** User is non-technical, often on phone. Push to Git, use GitHub Actions.
2. **ALWAYS ask "Quick fix or preview?"** before code/design changes. Quick fix → `main`. Preview → `staging`. Exceptions: data updates, docs, obvious bugs.
3. **Only `main` and `staging` branches.** NEVER create PRs or feature branches. Production: broadwayscorecard.com
4. **Automate everything.** Dynamic dates, no hardcoded years. Zero manual intervention.
5. **NEVER guess or fake data.**
6. **NEVER extract metadata from URLs.** URLs are inconsistent (2021 URL can have 2024 review). Use publish date + text.
7. **Batch scripts MUST checkpoint** every ~25 items. `if: always()` on commit steps. 5-retry push with `--rebase -X theirs`.
8. **Run `validate-data.js` before pushing.**
9. **Secrets MUST be in `env:` blocks** in workflows (NOT auto-available).
10. **Recoupment:** NEVER mark `recouped: true` without trade press citation.
11. **Deep Research:** NEVER auto-overwrite shows with `deepResearch.verifiedFields`.
12. **Bundle:** NEVER add to `data.ts` barrel. Import directly from `data-*.ts`.
13. **Images:** NEVER overwrite `PINNED_IMAGES` in `fetch-show-images-auto.js`.
14. **Multi-production:** Always pass year to `matchTitleToShow()`.
15. **Titles:** Add common-word show titles to `COMMON_WORD_TITLES` in `excerpt-validation.js`.

---

## Overview

Broadway review aggregator. Next.js 14, TypeScript, Tailwind, static export, Vercel.
724+ shows, 22K+ review files. Scoring: tier-weighted critic average (details in `src/config/scoring.ts`).

**Data:** `shows.json` (source of truth) | `reviews.json` (derived from `review-texts/` via rebuild) | `grosses.json` | `commercial.json` | `audience-buzz.json` | `critic-consensus.json`
**Show status:** `"open"` | `"previews"` | `"closed"`. Review-text dirs use versioned IDs (e.g., `bug-2026/`).

## Key Paths

- **Scoring:** `src/lib/engine.ts`, `src/config/scoring.ts`, `src/config/commercial.ts`
- **Pages:** `src/app/page.tsx`, `src/app/show/[slug]/page.tsx`
- **Data modules** (`src/lib/`): `data-core`, `data-grosses`, `data-awards`, `data-audience`, `data-commercial`, `data-consensus`, `data-lottery`, `data-reviews`, `data-creative`, `data-types`
- **Core scripts:** `gather-reviews.js`, `collect-review-texts.js`, `rebuild-all-reviews.js`, `validate-data.js`, `discover-new-shows.js`
- **SQLite:** `npm run db:build` then `node scripts/query.js "SQL"`
- **Local keys:** `.env` at project root. **Workflow docs:** `.github/workflows/CLAUDE.md`

## Secrets

| Secret | Use |
|--------|-----|
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | GPT-4o |
| `GEMINI_API_KEY` | Gemini |
| `BRIGHTDATA_TOKEN` | Scraping primary |
| `SCRAPINGBEE_API_KEY` | Scraping fallback |
| `BROWSERBASE_API_KEY`/`_PROJECT_ID` | Browser cloud |
| `FORMSPREE_FOLLOW_API_KEY`/`_FORM_ID` | Subscribers |
| `RESEND_API_KEY` | Email |
| `DISCORD_WEBHOOK_ALERTS` | Alerts |
| `MEZZANINE_APP_ID`/`_SESSION_TOKEN` | Mezzanine |

## Detailed Reference (read on demand, NOT loaded every session)

For schemas, pipeline details, and subsystem architecture:
- `.github/workflows/CLAUDE.md` — Workflow descriptions and schedules
- `memory/schemas-and-data.md` — Full data schemas and formats
- `memory/pipelines-and-workflows.md` — Collection, scraping, aggregator details
- `memory/subsystems.md` — Commercial, audience, Reddit, images, email systems
- `memory/historical-fixes-reference.md` — Past bug forensics and lessons
