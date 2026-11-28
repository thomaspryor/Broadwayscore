# Sprint Plan: OB Venue Extraction (Sprint 2 take-2)

## Overview
Build a new lib `scripts/lib/venue-listing-discover.js` that scrapes 4 OB non-profit venue pages (Atlantic, Vineyard, Signature, MCC) using subagent-verified URLs/selectors. New venue-discovered titles route through a staging file + cross-validation gate against Playbill/Lortel before promotion to `shows.json` — preventing the Pre-Mortem primary scenario where a venue page redesign floods shows.json with phantom shows and fires premature broadcasts. Reply to Nick once shipped.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|---|---|---|---|
| 1 | New lib + 4 venue configs + live scrape returns ≥1 per venue | 4 | 1S, 2M, 1L→split |
| 2 | Staging + promotion + anomaly gate + atomic write + status defaults | 5 | 3M, 2S |
| 3 | Integration into discover-new-shows + fixture tests + smoke + reply Nick | 4 | 1M, 1L→split, 1S, 1S |

---

## Sprint 1: Lib foundation + live extraction
**Demo:** `node -e "const m=require('./scripts/lib/venue-listing-discover.js'); m.scrapeVenueListing(/*atlantic*/).then(r => console.log(r))"` returns ≥1 real show title per venue (Atlantic / Vineyard / Signature / MCC) against live URLs.
**Risks:**
- Subagent-confirmed selectors may rot between subagent-time and implementation-time (≤2 hours apart, low risk)
- Adding `playwrightWaitForSelector` to scraper.js could subtly change behavior for existing Playwright-first callers
**MODEL:** Opus — new shared lib, multi-file refactor risk, scraper.js change touches load-bearing code.

### Task V-T0: Fix dead `preferPlaywright` flag in fetchSingleVenuePage
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/discover-new-shows.js` (modify ~line 799)
- **Description:** Currently `fetchSingleVenuePage()` does plain `fetch()` first and only falls back to `fetchPage()` on non-OK status. A venue with `preferPlaywright: true` therefore never reaches `fetchPage({preferPlaywright:true})`. Fix: if `venue.preferPlaywright`, skip the plain fetch and call `fetchPage(url, {preferPlaywright: true})` directly.
- **Acceptance criteria:**
  - VERIFY: synthetic test — temp venue with `preferPlaywright: true` calls `fetchPage` (capture via env-injected spy or console assertion); plain `fetch` is NOT called.
  - VERIFY: existing OWE venues (no flag) still hit plain fetch first (regression).

### Task V-T1: Create scripts/lib/venue-listing-discover.js
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/venue-listing-discover.js` (new)
- **Description:** Mirror `scripts/lib/playbill-ob-schedule.js`. Export pure `parseVenueListingHtml(venue, html)`, fetch wrapper `scrapeVenueListing(venue)`, named strategies `extractByLink(doc, venue)` + `extractBySelector(doc, venue)`, helper `extractJsonLdTheaterEvents(doc)`. Exclusion as `excludeTitlePatterns: regex[]` data — no inline lambdas.
- **Acceptance criteria:**
  - VERIFY: `node -e "console.log(Object.keys(require('./scripts/lib/venue-listing-discover.js')).sort())"` returns `['extractByLink','extractBySelector','extractJsonLdTheaterEvents','parseVenueListingHtml','scrapeVenueListing']`.
  - VERIFY: `parseVenueListingHtml({strategy:'link', linkPattern:/x/}, '<html></html>')` returns `[]` (empty doc).

### Task V-T2: Add 4 OB venue configs to the new lib
- **Complexity:** S
- **Depends on:** V-T1
- **Parallel:** No
- **Files:** `scripts/lib/venue-listing-discover.js` (modify)
- **Description:** Export `OB_VENUE_CONFIGS` table with Atlantic / Vineyard / Signature / MCC using subagent-verified URLs + selectors. Atlantic gets `scopeSelector: 'main'`. Signature gets `preferPlaywright: true` + `playwrightWaitForSelector: '.type-event'`. Vineyard gets `preferPlaywright: true`. Each has `excludeTitlePatterns: [...]` regex array.
- **Acceptance criteria:**
  - VERIFY: `node -e "console.log(require('./scripts/lib/venue-listing-discover.js').OB_VENUE_CONFIGS.map(v=>v.name))"` returns the 4 venue names.
  - VERIFY: each config validates — URL is parseable, strategy is one of `['link','selector']`, exclusion patterns are valid regex.

### Task V-T3: Add playwrightWaitForSelector option to scraper.js
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes (with V-T0/V-T1)
- **Files:** `scripts/lib/scraper.js` (modify `fetchWithPlaywright` + `fetchPage` option passthrough)
- **Description:** Add `options.playwrightWaitForSelector` to `fetchPage()` — passed to `fetchWithPlaywright()`, which after `page.goto()` runs `await page.waitForSelector(opts.playwrightWaitForSelector, {timeout: 15000})` if set. Default behavior unchanged. Required for Signature (`.type-event` — `networkidle` times out).
- **Acceptance criteria:**
  - VERIFY: `node -e "require('./scripts/lib/scraper.js').fetchPage('https://signaturetheatre.org/productions/', {preferPlaywright:true, playwrightWaitForSelector:'.type-event'}).then(r => console.log('html size:', r.content.length, 'has type-event:', r.content.includes('type-event')))"` returns non-empty HTML with `type-event` markers.
  - VERIFY: existing call-site without the option returns unchanged result (parity test against `https://playbill.com/article/schedule-of-upcoming-off-broadway-shows-2` — same byte count as before).

---

## Sprint 2: Safety infrastructure (staging, promotion, anomaly, atomic write, status defaults)
**Demo:** Dry-run produces `data/audit/ob-venue-candidates.json` with all candidates; `scripts/promote-ob-venue-candidates.js --dry-run` gates correctly (only candidates with Playbill/Lortel confirmation within 72h get marked promotable); anomaly gate fires on a synthetic 2× spike.
**Risks:**
- Cross-validation might be too strict (Lortel + Playbill OB miss some legitimate shows) → `--admin-force` escape hatch
- Anomaly gate baseline starts empty → first 7 days are no-op (acceptable)
**MODEL:** Opus for V-T5/V-T6/V-T9 (multi-file, downstream contract changes); Sonnet for V-T7/V-T8 (small focused helpers).

### Task V-T5: Staging file for venue candidates
- **Complexity:** M
- **Depends on:** V-T1
- **Parallel:** Yes
- **Files:** `scripts/lib/venue-listing-discover.js` (extend `scrapeVenueListing` to write to staging), `data/audit/.gitkeep`
- **Description:** Add `writeStagingCandidate(candidate, stagingPath)` to the lib. `scrapeVenueListing` collects results into `data/audit/ob-venue-candidates.json` as `[{title, venue, source, discoveredAt: ISO, candidateHash, evidence: {url, selector, fetchedHtmlBytes}}]`. Replace-or-update by `candidateHash` (sha256 of normalized title + venue). Atomic write (tmp + rename) for the staging file itself.
- **Acceptance criteria:**
  - VERIFY: `node -e "require('./scripts/lib/venue-listing-discover.js').scrapeVenueListing(/*atlantic*/).then(()=>console.log(JSON.parse(require('fs').readFileSync('data/audit/ob-venue-candidates.json'))))"` produces ≥1 candidate object.
  - VERIFY: re-running doesn't duplicate (replace-by-hash).

### Task V-T8: Atomic shows.json write helper
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/atomic-shows-write.js` (new), unit test in `tests/unit/atomic-shows-write.test.mjs` (new)
- **Description:** `atomicWriteShowsJson(showsJsonObject, options)` — writes `data/shows.json.tmp`, runs line-count diff vs current `data/shows.json`, aborts if drop > 5% AND no `--allow-shrink` flag. Renames on success. Pure function takes parsed JSON, options control behavior.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/atomic-shows-write.test.mjs` passes (100-line file → tmp with 50 lines aborts; tmp with 105 lines succeeds; tmp with 95 lines succeeds at 5% threshold; allowShrink: true skips check).

### Task V-T7: Per-venue anomaly gate
- **Complexity:** M
- **Depends on:** V-T5
- **Parallel:** Yes (with V-T6)
- **Files:** `scripts/lib/venue-anomaly.js` (new), `data/audit/ob-venue-counts.json` (new — gitkeep'd empty), unit test
- **Description:** `checkVenueAnomaly(venueName, todayCount)` — reads 7-day rolling per-venue counts, compares today vs median. If today > 2× median (and median ≥ 1), set `process.exitCode = 1` + `console.warn('::warning::venue X anomaly: today=N median=M')`. Always appends today's count to the rolling file. First 7 runs per venue are no-op (insufficient baseline).
- **Acceptance criteria:**
  - VERIFY: unit test — seed counts with `[3,4,3,4,3,4,3]` for atlantic; `checkVenueAnomaly('atlantic', 9)` triggers (exits 1); `checkVenueAnomaly('atlantic', 7)` doesn't.
  - VERIFY: unit test — empty counts file → 7 successive runs are no-op (exit 0).

### Task V-T6: Promotion script with cross-validation
- **Complexity:** L → split: V-T6a (cross-validation helper) + V-T6b (promotion script)
- **Depends on:** V-T5, V-T8

#### Task V-T6a: Cross-validation helper
- **Complexity:** M
- **Depends on:** V-T5
- **Parallel:** No
- **Files:** `scripts/lib/ob-cross-validation.js` (new), unit test
- **Description:** `isCandidateConfirmed(candidate, {playbillEntries, lortelEntries, windowHours})` — returns true if `candidate.title` (normalized) appears in either source list. Uses `scripts/lib/title-match.js` `normalizeTitle()`.
- **Acceptance criteria:**
  - VERIFY: unit test — candidate "Indian Princesses" + playbillEntries containing "Indian Princesses" → true. Candidate "Mystery Gala 2026" + neither source containing it → false.

#### Task V-T6b: Promotion script
- **Complexity:** M
- **Depends on:** V-T6a, V-T8
- **Parallel:** No
- **Files:** `scripts/promote-ob-venue-candidates.js` (new)
- **Description:** Reads `data/audit/ob-venue-candidates.json`. For each candidate: call `scrapePlaybillOBData()` + `scrapeLortel()` (existing in enrich-off-broadway-dates) → `isCandidateConfirmed(candidate, sources, {windowHours: 72})`. If confirmed: build show entry with `status: 'announced'`, `openingDate: null`, push into `shows.json` via `atomicWriteShowsJson`. If `--admin-force=<title>`: promote that title regardless. Logs decisions to `data/audit/ob-promotion-log.jsonl`.
- **Acceptance criteria:**
  - VERIFY: end-to-end — seed staging with a known Playbill-OB title (e.g. "Indian Princesses") → `node scripts/promote-ob-venue-candidates.js --dry-run` reports it as promotable. Seed with unverifiable title → reports not promotable.
  - VERIFY: `--admin-force="<title>"` reports the named title as promotable regardless of cross-validation.

### Task V-T9: Status defaults + orchestrator null-opening skip
- **Complexity:** M
- **Depends on:** V-T6b
- **Parallel:** No
- **Files:** `scripts/promote-ob-venue-candidates.js` (modify — already sets status/openingDate per V-T6b spec), `.github/workflows/opening-night-orchestrator.yml` (audit + modify if needed)
- **Description:** Confirm `opening-night-orchestrator.yml` skips shows where `openingDate === null`. Grep the workflow for `openingDate` null-check; if absent, add it. Otherwise just confirm V-T6b's defaults flow through correctly.
- **Acceptance criteria:**
  - VERIFY: `grep -E "openingDate.*null|!.*openingDate|openingDate.*\?" .github/workflows/opening-night-orchestrator.yml` returns a guard match.
  - VERIFY: synthetic show entry `{status:'announced', openingDate:null, category:'off-broadway'}` does NOT trigger the orchestrator's dispatch step (dry-run the workflow's filter logic via `node -e` or `gh workflow run --dry-run` if supported).

---

## Sprint 3: Integration + fixture tests + smoke + reply Nick
**Demo:** `node scripts/discover-new-shows.js --dry-run --include-off-broadway` returns candidates flowing through new lib → staging → promotion gate; live smoke runs green; Nick has been replied to.
**Risks:**
- Removing the 4 broken OB stub entries from `VENUE_LISTING_PAGES` while wiring new lib could break WE/OWE by mistake → S2-T1a baseline re-diff catches
- Fixture-based tests pass forever even if live DOM rots → V-T11 smoke is the live check
**MODEL:** Opus for V-T4 (touches load-bearing discover-new-shows.js); Sonnet for V-T10 (data + tests) and V-T11/V-T12.

### Task V-T4: Wire scrapeVenueListing into discover-new-shows.js
- **Complexity:** M
- **Depends on:** V-T1, V-T2, V-T6b
- **Parallel:** No
- **Files:** `scripts/discover-new-shows.js` (modify — remove 4 broken OB stub entries from VENUE_LISTING_PAGES; replace the OB-venue-listing call with a loop over OB_VENUE_CONFIGS calling scrapeVenueListing)
- **Description:** Replace the existing `await fetchShowsFromVenueListings('off-broadway')` call with `for (const v of OB_VENUE_CONFIGS) results.push(await scrapeVenueListing(v))`. Wrap in `Promise.allSettled` for parallel + isolation. Per-candidate-cap (V-T6 from parent plan) still applies via existing check. OWE path completely untouched.
- **Acceptance criteria:**
  - VERIFY: WE/OWE baseline byte-identical — re-run `node /tmp/owe-baseline-capture.js` and `diff /tmp/owe-baseline-pre-refactor.json /tmp/owe-post-refactor.json` returns empty.
  - VERIFY: `node scripts/discover-new-shows.js --dry-run --include-off-broadway` produces candidates with `source: 'venue-page:atlantic'` etc., AND writes to staging file (not shows.json directly).

### Task V-T10: Fixture tests per venue
- **Complexity:** L → split into V-T10a/b/c/d (one per venue)
- **Depends on:** V-T1, V-T2

#### Task V-T10a: Atlantic fixture + test
- **Complexity:** S
- **Depends on:** V-T2
- **Parallel:** Yes
- **Files:** `tests/fixtures/ob-discovery/atlantic.html` (new), `tests/unit/venue-extract-atlantic.test.mjs` (new)
- **Description:** Capture live HTML, save as fixture. Test calls `parseVenueListingHtml(atlanticConfig, fixture)` → asserts subagent-listed titles (Indian Princesses, The Saviors, Let's Love!, The Reservoir, The Judith Champion MixFest, Elephant & Piggie's) are extracted; negative: synthetic banner "2026 Spring Gala Benefit" inserted into fixture is filtered.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/venue-extract-atlantic.test.mjs` passes.

#### Task V-T10b: Vineyard fixture + test
- **Complexity:** S
- **Depends on:** V-T2
- **Parallel:** Yes
- **Files:** `tests/fixtures/ob-discovery/vineyard.html` (new), `tests/unit/venue-extract-vineyard.test.mjs` (new)
- **Description:** Same pattern. Expected titles: `||:GIRLS:||:CHANCE:||:MUSIC:||`, MS. BLAKK FOR PRESIDENT. Negative: synthetic "Vineyard Annual Gala" filtered.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/venue-extract-vineyard.test.mjs` passes.

#### Task V-T10c: Signature fixture + test
- **Complexity:** S
- **Depends on:** V-T2
- **Parallel:** Yes
- **Files:** `tests/fixtures/ob-discovery/signature.html` (new), `tests/unit/venue-extract-signature.test.mjs` (new)
- **Description:** Expected: ANIMAL WISDOM, FISH, KING OF THE YEES, MILES FOR MARY, ANGELA'S MIXTAPE (5 upcoming). 9 past-show entries also present in DOM but test asserts upcoming/past filtering by ancestor heading.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/venue-extract-signature.test.mjs` passes; upcoming = 5, past omitted.

#### Task V-T10d: MCC fixture + test + workflow registration
- **Complexity:** S
- **Depends on:** V-T10a, V-T10b, V-T10c
- **Parallel:** No (single edit to test.yml registers all 4)
- **Files:** `tests/fixtures/ob-discovery/mcc.html` (new), `tests/unit/venue-extract-mcc.test.mjs` (new), `.github/workflows/test.yml` (modify line 613)
- **Description:** MCC fixture + test (expected: BIRTHRIGHT, UNCENSORED, COLD WAR CHOIR PRACTICE, FRESHPLAY FESTIVAL, CAROLINE). Then register all 4 new tests in `test.yml:613` explicit list.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/venue-extract-mcc.test.mjs` passes.
  - VERIFY: `grep -c "venue-extract-" .github/workflows/test.yml` returns 4.

### Task V-T11: Live smoke script
- **Complexity:** S
- **Depends on:** V-T1, V-T2, V-T4
- **Parallel:** Yes
- **Files:** `scripts/smoke-ob-discovery.js` (new)
- **Description:** Runs `scrapePlaybillOBData()` + `scrapeVenueListing(v)` for each of 4 venues live. Reports counts vs `data/audit/ob-venue-counts.json` rolling median. Manual run only — not in CI.
- **Acceptance criteria:**
  - VERIFY: `node scripts/smoke-ob-discovery.js` prints `OK: playbill=N venues=N/4` against live URLs; exit code 0.

### Task V-T12: Reply Nick
- **Complexity:** S
- **Depends on:** V-T4 + V-T6b confirmed working end-to-end
- **Parallel:** No (after-ship comms)
- **Files:** Outbound email
- **Description:** Email nicholasrk8@gmail.com confirming Atlantic/Vineyard/MCC venues now flowing (and Signature once cross-validation passes). Acknowledge his report. Subject: "Re: Off Broadway listings — shipped Atlantic/Vineyard/MCC coverage."
- **Acceptance criteria:**
  - VERIFY: email send timestamp captured in the V-T12 commit message; reply visible in sent folder.

---

## Dependencies Graph
```
V-T0 ──────────────────────────────────────────────┐
V-T1 ──┬─→ V-T2 ──→ V-T4 ─────────────────────┐    │
       └─→ V-T5 ──┬─→ V-T6a ──→ V-T6b ──→ V-T9│    │
                  └─→ V-T7                    │    │
V-T3 ─────────────────────────────────────────┤    │
V-T8 ──────────→ V-T6b                        │    │
V-T1 ──→ V-T10a/b/c ──→ V-T10d ──────────────┐│    │
                                              ▼▼    │
                                            V-T11   │
                                                    │
                          V-T4 + V-T6b ──→ V-T12 ◀──┘
```

## Subagent Execution Map (within one `/execute-plan` session)

```
Track 1 (lib + integration):    V-T1 → V-T2 → V-T4 → V-T11 → V-T12
Track 2 (scraper opt + fix):    V-T0 → V-T3
Track 3 (safety infra):         V-T5 → V-T7
                                       └→ V-T6a → V-T6b → V-T9
                                V-T8 ──────────────↗
Track 4 (fixture tests):        V-T10a, V-T10b, V-T10c (parallel) → V-T10d
Sync points:                    ────── after Sprint 1 ────── after Sprint 2 ──────
```

**Parallel sprints:** Sprints 1 and 2 share no files in the critical path — V-T5/V-T7/V-T8 (safety infra) can begin once V-T1 (lib skeleton) lands. Sprint 3 tests (V-T10a-c) can run in parallel with each other but must follow V-T2.

**Critical path:** V-T1 → V-T2 → V-T4 → V-T12 — ~3.5 hours sequential. With subagent parallelism: ~2.5 hours wall time.

**Max subagent parallelism:** 4 (tracks 1/2/3/4 simultaneously during Sprint 1-2 overlap).

**Cross-session plan:** Single session — total ~6h fits one Opus session. If interrupted: Sprint 1 ships independently (the new lib exists + 4 configs verified + scraper.js opt added — usable from any future caller). Sprint 2 is shippable standalone (safety infra useful even without venue scrapers wired). Sprint 3 finalizes.

## Known Edge Cases
- **Atlantic Elementor classes versioned** — `elementor-heading-title` may become `elementor-widget-heading__title` on theme upgrade. V-T7 anomaly gate catches "count drops to 0" within 7 days; V-T11 live smoke catches it on manual run.
- **Signature `networkidle` times out** — must use `domcontentloaded` + `waitForSelector('.type-event')`. V-T3 adds the opt; V-T2 config wires it. Without V-T3, Signature returns 0.
- **Vineyard `www` subdomain** — `vineyardtheatre.org/showsevents/` works; `www.vineyardtheatre.org/showsevents/` does NOT. V-T2 config has no www.
- **Vineyard between seasons** — only 2 shows currently listed. Anomaly gate skips first 7 runs.
- **Signature past shows** — 9 past + 5 upcoming on the same page. V-T2 selector + V-T10c test must filter to upcoming-only via ancestor heading.
- **MCC season-page URL** — `/our-2025-26-season/` is a fixed-year URL. Will rot in mid-2026 → need `/our-2026-27-season/`. Add a TODO comment in V-T2 config.
- **Cross-validation false negatives** — Lortel doesn't cover all OB; Playbill OB article lists ~13 shows. A legitimate Atlantic/Vineyard show may not appear in either → `--admin-force` is the escape hatch.
- **First 7 days of anomaly gate** — empty `ob-venue-counts.json` → no baseline → no alarms. Acceptable; documented in V-T7.
- **`data/shows.json` symlink** — in this worktree, `data/shows.json` is a symlink to `~/broadway-scorecard-data/shows.json`. Atomic write (V-T8) must dereference correctly.
- **Parallel-session race on `data/shows.json`** — CI cron runs every 30 min. Pull immediately before V-T6b promotion; V-T8 atomic write minimizes window.

## Changes from Critique (carried from `/plan-review` of v2)
| Change | Reason | Source |
|---|---|---|
| Move venue extraction to `scripts/lib/venue-listing-discover.js` | Codebase pattern: every other discovery source is in `scripts/lib/*-discover.js` | Design P0 |
| Strategies as named functions; exclusions as regex arrays | Inline `titleFilter: (t) => ...` is unmaintainable + untestable | Codex, S&DA, Design |
| Fix `preferPlaywright` dead-code at fetchSingleVenuePage:799 | Flag never reaches scraper.js — entire Vineyard strategy depends on this | Codex P0 |
| Use subagent-verified URLs (3 of 4 differ from v1 guesses) | Atlantic /productions/, Vineyard /showsevents/ (no www), Signature /productions/, MCC /our-2025-26-season/ | Subagent findings |
| Atlantic `scopeSelector: 'main'` not bare h2.elementor-heading-title | Sitewide selector → Pre-Mortem PRIMARY 14-phantom scenario | S&DA + Pre-Mortem |
| Add `playwrightWaitForSelector` opt | Signature `networkidle` times out at 45s | Subagent + Design |
| Staging file + cross-validation gate before shows.json write | Phantom shows could fire broadcasts to real subscribers | User Impact P0 + Pre-Mortem |
| Anomaly gate (>2× rolling median) | Catches the 14-phantom scenario at run-time | Pre-Mortem |
| Atomic shows.json write with line-count diff gate | Pre-Mortem secondary: CI timeout drops 30+ entries | Pre-Mortem secondary |
| Status `'announced'` + openingDate=null defaults | Orchestrator must skip new venue shows pre-confirmation | User Impact P0 |
| Smoke script CREATE not extend | `smoke-ob-discovery.js` doesn't exist | Codex |
| Reply Nick task | Close the loop with the user who filed the report | User Impact |

## Key Risks

1. **Selector rot** — Atlantic's Elementor classes or Signature's `.type-event` could change on a theme upgrade. **Mitigation:** Fixture tests + live smoke (V-T11) + anomaly gate (V-T7). Manual recovery via re-probe + config update.

2. **Cross-validation too strict** — Lortel + Playbill OB don't cover everything; legitimate Atlantic/Vineyard show might never get confirmed → stuck in staging forever. **Mitigation:** `--admin-force=<title>` flag in V-T6b. Could also extend window from 72h → 14d if needed (config change, 1 line).

3. **V-T3 scraper.js change leaks to other callers** — Adding `playwrightWaitForSelector` opt could affect any caller that explicitly sets options. **Mitigation:** Default = no waitForSelector (no behavior change); V-T3 acceptance includes parity test against existing Playwright-first domain.

## Self-validation checklist (Phase 3)

1. **Completeness:** Sprint 1 demoable (lib + 4 venue scrapes returning real titles). Sprint 2 demoable (staging + promotion gate). Sprint 3 demoable (full pipeline + reply Nick). **PASS**
2. **Atomicity:** V-T6 split into V-T6a/b; V-T10 split into V-T10a/b/c/d. **PASS**
3. **Dependency chain:** No cycles. Critical path V-T1 → V-T2 → V-T4 → V-T12. **PASS**
4. **Test coverage:** Every task has a runnable VERIFY (unit test, grep, end-to-end). **PASS**
5. **Missing work:** Dual-repo write — V-T8 handles `data/shows.json` symlink to `~/broadway-scorecard-data/`. **PASS**
6. **Ordering:** Sprint 2 safety infra can run parallel with Sprint 1 lib work (per subagent map). **PASS**
7. **Parallel workstreams:** 4 subagent tracks maximally exploited. **PASS**
8. **Manual before automated:** V-T11 smoke is the manual live verification before relying on cron pipeline. **PASS**
9. **Scale check:** Discovery cron runs daily; 4 venues × ~5 candidates each = 20/day max. Staging file at most ~100 entries before promotion. `shows.json` already 242k lines; 4 venues won't push it 10x. **PASS**
