---
name: clone-inherited-dates-yyyy-id
description: "YYYY-suffixed show ids can inherit their historical namesake's opening date + status=open; audit id-year vs date-year and previews>opening gap"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a738e0c7-f019-40de-89dd-f6f4f8ecc46a
---

Newly-discovered revivals get a `{title}-{YYYY}` id but can inherit the WRONG production's dates — their classic namesake's — and land with `status=open`. On 2026-06-28 three upcoming 2026-27 Broadway revivals showed as "open since 1935/1989/1998" on the live site: `awake-and-sing-2026` (opening 1935-02-19), `a-few-good-men-2026` (1989-11-15), `the-sound-of-music-2026` (1998-03-12). Separately, several closed OB shows carried `previewsStartDate` from a different production/year (`sunset-baby-off-broadway-2026` previews 2013 vs opening 2024 — the case CLAUDE.md already names; also grangeville, oratorio, eurydice; and `three-houses` had previews AFTER opening).

**Why:** discovery/clone cloned the namesake's metadata. Date guards and opening-night logic key off these dates, and the live `/broadway` list rendered them as long-open shows.

**How to apply — two cheap audits:**
1. **id-year vs date-year:** for ids matching `-(\d{4})$`, flag when `|idYear - openingYear| > 1`. Filter out the LEGIT cases: West End long-runners and historical OB backfill use the *import* year as the suffix (e.g. `the-mousetrap-west-end-2021` opened 1952 — correct). The real bugs are recent id-year (>=2025) with a decades-old opening AND `status=open`.
2. **previews >60d before opening:** abnormal for one production. But COVID-delayed shows (previews early-2020 → opened 2021/22: Company, Six, Lehman Trilogy, The Minutes) are LEGIT — do NOT "fix" them. Verify each suspect's real dates via Playbill/BroadwayWorld before editing; never guess.

Fix in `broadway-scorecard-data/shows.json`: `git pull --rebase` first (CI commits ~every 30 min), correct dates + status (`upcoming`/`announced`, not `open`), discard local derived `reviews.json` before rebasing, push, then trigger rebuild-fast to deploy. Verify live via the slim public JSON's `pd` key (previews date), not `status` (not in the slim file). Related: [[feedback_manual_stub_bypasses_validation]], [[feedback_shows_json_category_at_schedule]].
