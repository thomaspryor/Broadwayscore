---
name: feedback_gd_historical_odds_backfill
description: "GoldDerby historical Tony odds: cache + audit script + key caveats. Use for Reddit-grade backtest content."
metadata:
  type: feedback
---

# GD Historical Tony Odds Backfill (2026-05-23)

**Where the data lives:**
- Cache: `.cache/gd/` (gitignored) — raw API JSON keyed by `sha1(/latest-odds-v3/{leagueId}/{catId}/combined).slice(0,16)`. Re-create with `node scripts/scrape-gold-derby-tonys.js --all-historical`.
- Audit output: `data/analysis/gd-historical-accuracy.json` — committed; safe to read.
- Audit script: `scripts/audit-gd-historical-accuracy.js`.
- Bulk fetcher: `scripts/scrape-gold-derby-tonys.js --all-historical` (canonical 2013-2025 set).
- Discovery: `scripts/scrape-gold-derby-tonys.js --discovery-only`.

**Why:** Enabled Reddit-grade backtest stats ("GD's pre-ceremony favorite won X of Y Tonys"). The /plan-review caught a critical pre-mortem risk that the `/latest-odds-v3/` endpoint *might* serve current retail-betting odds (post-hoc pile-on) for closed leagues. Verified pre-ceremony via two gates in `scripts/verify-gd-snapshot-timing.js`: Hadestown 2019 within 0.3pp of contemporary ~88%, and two upsets (Kinky Boots 2013 @39.2%, The Outsiders 2024 @21.7%) — both structurally impossible for post-hoc data.

**Coverage caveats** (from S3 discovery + S4 audit):
- **13 GD leagues** total (2013-2026), but only **11 usable cycles** for backtest:
  - 2014 league exists but `/latest-odds-v3/` returns `[]` for all 4 Big Four cats — genuine API gap.
  - 2020 league is missing Best Revival of a Musical (it wasn't awarded in COVID-truncated 2019-20).
  - 2021 has no GD league (COVID merged into 2020 ceremony).
  - 2026 is current-cycle (no winners yet) — excluded from backtest.
- **2 title-form discrepancies** that are NOT bugs (same shows, different text):
  - Topdog/Underdog (GD slash) vs `topdog-underdog`
  - Sunset Blvd. (GD abbr) vs `sunset-boulevard`

**Headline backtest results (43 races, 11 cycles):**
| Category | Hit rate | Notable |
|---|---:|---|
| Best Musical | 9/11 = 82% | Biggest upset: The Outsiders 21.7% (2024); biggest blowout: Hamilton 98.7% (2016) |
| Best Play | 9/11 = 82% | Biggest upset: Purpose 10.4% beat Oh, Mary! 83.2% (2025) |
| Best Revival of a Musical | 8/9 = 89% | Biggest upset: Once on This Island 11.7% (2018) |
| Best Revival of a Play | 8/10 = 80% | Biggest upset: The Boys in the Band 21.2% (2019) |

**Calibration:** when GD's favorite is ≥90%, hit rate is 12/12 = 100% across all categories.

**Shared lib:** `scripts/lib/gd-api.js` was extracted from `scrape-gold-derby-tonys.js` in S2-T2 with a parity gate (`scripts/test-gd-scraper-parity.js`). Both the live cron and the historical backfill use the same primitives — keep that lib pure, keep the parity test passing for any future edit.

**Key files:** `scripts/lib/gd-api.js` · `scripts/scrape-gold-derby-tonys.js` · `scripts/audit-gd-historical-accuracy.js` · `scripts/verify-gd-snapshot-timing.js` · `scripts/test-gd-scraper-parity.js` · `data/analysis/gd-historical-accuracy.json`

**Re-run the full pipeline from scratch:**
```
node scripts/verify-gd-snapshot-timing.js          # gate
node scripts/scrape-gold-derby-tonys.js --all-historical   # ~80s fresh, ~1s cached
node scripts/audit-gd-historical-accuracy.js --save
```
