---
name: feedback_promote_silent_audits_to_checks
description: "A silent audit file (data/audit/*.json) that nobody reads isn't monitoring; promote it to a health-check.js CHECK to drive escalation. Also venue-aware Mezzanine overrides for date-less catalogs."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 29f089c4-7922-4ae6-9938-5fe644aece01
---

When an audit writes findings to `data/audit/*.json` (or a passive HTML section in the daily digest), that is **detection without surfacing** — it does not prevent misses. The 2026-06-22 Encores La Cage incident: Mezzanine had 85 audience ratings for the show, the `mezzanine-coverage.json` audit correctly flagged it the day before, but it rendered only as a passive digest section buried among ~36 closed-revival flags and never drove the subject line. The user found it by eyeballing the page.

**Why:** Per `.github/workflows/CLAUDE.md`, only **checks** (`runCheck` → `results.push` in `scripts/health-check.js`, with an `AUTO_FIX_PLAYBOOK` entry) drive the email subject line, unfixed-error count, and auto-triage. Passive body sections get ignored.

**How to apply:**
- If an audit detects a user-facing problem, promote it to a `runCheck` and add a PLAYBOOK regex entry. A `workflow:`-less entry with `humanAction` is valid (it skips auto-dispatch, falls back to the human instruction — see `Sync: cast coverage`).
- **Narrow to the actionable subset.** Raw audits are noisy (36 flags). Filtering to currently-OPEN shows took it to 1 real signal. Signal-to-noise is what makes a check get read.
- An audit file that EXISTS but won't `JSON.parse` must return `warn`, not `ok` — a broken input silently downgraded to "clean" re-hides the very class you were guarding.
- If a scraper writes a PUBLIC-repo audit file, the workflow must explicitly `git add` + push it (most audience workflows only `push-core-data` to the PRIVATE repo). Mirror `update-mezzanine.yml`'s coverage-audit commit step.
- Catalog-matched sources (Mezzanine, Theatr) can run this unmatched-catalog audit; per-URL scrapers (Show Score, broadway.com) cannot — they need a market-peer-absence detector instead.

**Venue-aware Mezzanine override:** Mezzanine `Production` records have NO opening-date field (`mYear` is always NaN), so same-titled NYC productions (Marquis/Longacre/City Center "La Cage aux Folles") can't be split by year. A name-only `MEZZANINE_OVERRIDES` entry over-merges them. Use the `{name, venue}` form to pin to one theater. Theatr uses a SEPARATE `THEATR_OVERRIDES` table in its own scraper — don't conflate. See [[feedback_dedup_genre_suffix]], [[feedback_audience_scrapers_share_normalize]].
