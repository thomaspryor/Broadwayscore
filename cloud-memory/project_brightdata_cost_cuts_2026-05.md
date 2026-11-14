---
name: Bright Data SERP cost cuts (April 2026 spike)
description: April 2026 BD bill hit $312 (168K SERP) on 56 openings — four reversible YAML/flag cuts shipped 2026-05-08 (PR #322) to recover ~40-50% on heavy months
type: project
originSessionId: 148aa1aa-27c5-452c-8d43-502927654381
---
April 2026 Bright Data invoice: **$312.43** total — SERP $252 (168,260 calls) + Web Unlocker $67 (44,950 calls). Volume driven by **56 openings in April** (12 BW + 22 OB + 22 WE/OWE — end-of-season + pre-Tonys squeeze, observed by counting `openingDate` matches in shows.json).

**Why:** Trying to reason from per-script SERP counts to a $250 bill always undershoots — the dominant driver is the orchestrator polling-loop multiplier on opening nights. Each orchestrator cron firing on a show ran up to 24 iterations × ~30 SERP/iter (with first 8 deferred). Multiply by 5 daily cron windows × multi-day press windows × 56 shows.

**How to apply:** When the next BD bill arrives:
1. Count openings via `node -e "const s=require('./data/shows.json');const arr=s.shows||s;console.log(arr.filter(x=>x.openingDate&&x.openingDate.startsWith('YYYY-MM')).length)"` — that's the dominant proxy for SERP volume.
2. Compare against forecast: ~$5-10 baseline + ~$5-8 per opening at current settings (post-PR-#322).
3. Cuts already shipped (PR #322, commit `11f9a2971b`):
   - `opening-night-orchestrator.yml` MAX_ITERATIONS 24→16
   - `gather-reviews.yml` opening-night `--max-searches` 200→80
   - `brand-mention-monitor.yml` every-2h → daily 13:17 UTC + dropped `fetchGoogleNewsMentions` from `scripts/lib/brand-mention-serp.js`
   - `enrich-off-broadway-dates.yml` + `enrich-west-end-dates.yml` daily → weekly Monday (existing weekly Thursday kept)
4. Untouched lever if more cuts needed: add a BD-SERP monthly budget gate mirroring `scripts/lib/check-sb-credits.js` (referenced in the original analysis but not shipped).
5. Web Unlocker line ($67 for April) tracks roughly with overall page-fetch volume; not addressed in PR #322.
