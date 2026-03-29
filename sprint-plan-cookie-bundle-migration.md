# Sprint Plan: Cookie Secrets Bundle Migration

## Overview
Replace 33 individual `*_COOKIES` GitHub secrets with ~11 bundled `COOKIES_BUNDLE_*` secrets to stay under GitHub's 100-secret limit. A shared `cookie-loader.js` module centralizes all cookie loading logic (currently duplicated in 4 scripts), with a 3-tier fallback: bundles -> individual env vars -> local files.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity | Model |
|--------|------|-------|------------|-------|
| 1      | Shared cookie-loader + wire all scripts | 7 | 4S, 2M, 1S | Opus |
| 2      | Python push script + create bundle secrets | 3 | 1M, 2S | Sonnet |
| 3      | Migrate all 11 workflows to bundles | 6 | 2S, 3M, 1S | Sonnet |
| 4      | Verify + delete old secrets | 2 | 2S | Sonnet |

---

## Sprint 1: Shared Cookie Loader + Wire Scripts
**Goal:** All 4 cookie-consuming scripts use a single shared loader. Everything still works with existing individual secrets and local files.
**Demo:** Run each script locally and in CI — same behavior as before, but through shared module.
**Risks:** Naming mismatches between env vars and file keys (THR vs hollywoodreporter). Missing a cookie domain mapping during extraction.
**MODEL:** Opus — multi-file refactor with shared interface design

### Task S1-T1: Create scripts/lib/cookie-loader.js
- **Complexity:** M (new file, complex mapping logic)
- **Depends on:** None
- **Parallel:** Yes (Agent A)
- **Files:** `scripts/lib/cookie-loader.js` (new)
- **Description:** Create shared cookie loader with 3-tier fallback: (1) scan all `COOKIES_BUNDLE_*` env vars, decode, find outlet by key; (2) check individual env var (e.g., `WSJ_COOKIES`); (3) read local `data/cookies/{fileKey}.json`. Export: `loadCookiesForDomain(domain)`, `hasCookiesForUrl(url)`, `buildCookieHeaderForUrl(url, cookies)`. Include full domain-to-envvar-to-filekey mapping (audit all naming mismatches, not just THR). Add try/catch per bundle decode with specific error messages.
- **Acceptance criteria:**
  - VERIFY: `node -e "const cl = require('./scripts/lib/cookie-loader'); console.log(typeof cl.loadCookiesForDomain, typeof cl.hasCookiesForUrl, typeof cl.buildCookieHeaderForUrl)"` prints `function function function`
  - VERIFY: `node -e "const cl = require('./scripts/lib/cookie-loader'); const c = cl.loadCookiesForDomain('wsj.com'); console.log(c?.length || 'no cookies')"` loads from local file and prints cookie count

### Task S1-T2: Wire collect-review-texts.js to shared loader
- **Complexity:** M (largest consumer, ~150 lines to replace, lines 361-510)
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** `scripts/collect-review-texts.js` (modify)
- **Description:** Replace inline `COOKIE_DOMAIN_MAP`, `_cookieCache`, `loadCookiesForDomain()`, `hasCookiesForUrl()`, `buildCookieHeaderForUrl()` with imports from `scripts/lib/cookie-loader.js`. Keep `injectCookies()` in-place (Playwright-specific). Run against a real show to verify identical behavior.
- **Acceptance criteria:**
  - VERIFY: `node scripts/collect-review-texts.js --show=giant-2026 --dry-run 2>&1 | head -20` runs without errors
  - VERIFY: `grep -c "COOKIE_DOMAIN_MAP" scripts/collect-review-texts.js` returns 0 (mapping removed)
  - VERIFY: `grep "cookie-loader" scripts/collect-review-texts.js` shows the import

### Task S1-T3: Wire check-cookie-health.js to shared loader
- **Complexity:** S (simpler loading logic, lines 70-157)
- **Depends on:** S1-T1
- **Parallel:** Yes (can parallel with S1-T2)
- **Files:** `scripts/check-cookie-health.js` (modify)
- **Description:** Replace inline `ALL_OUTLETS` mapping and `loadCookies()` function with shared loader. The health check still needs the outlet→envvar mapping for reporting — import it from cookie-loader.
- **Acceptance criteria:**
  - VERIFY: `node scripts/check-cookie-health.js --structure-only 2>&1 | grep -c "cookies"` produces non-zero output
  - VERIFY: `grep "cookie-loader" scripts/check-cookie-health.js` shows the import

### Task S1-T4: Wire recover-wsj-subscriber.js to shared loader
- **Complexity:** S (bespoke WSJ-only logic, lines 76-106)
- **Depends on:** S1-T1
- **Parallel:** Yes (can parallel with S1-T2, S1-T3)
- **Files:** `scripts/recover-wsj-subscriber.js` (modify)
- **Description:** Replace inline `loadCookies()` that only reads `WSJ_COOKIES` with `loadCookiesForDomain('wsj.com')` from shared loader.
- **Acceptance criteria:**
  - VERIFY: `node -e "require('./scripts/recover-wsj-subscriber')"` doesn't throw (module loads cleanly)
  - VERIFY: `grep "WSJ_COOKIES" scripts/recover-wsj-subscriber.js` returns 0 matches (direct reference removed)

### Task S1-T5: Wire recollect-for-scores.js to shared loader
- **Complexity:** S (small COOKIE_DOMAIN_MAP, lines 54-98)
- **Depends on:** S1-T1
- **Parallel:** Yes (can parallel with S1-T2, S1-T3, S1-T4)
- **Files:** `scripts/recollect-for-scores.js` (modify)
- **Description:** Replace inline `COOKIE_DOMAIN_MAP` and `loadCookiesForUrl()` with imports from shared loader. Keep `ESSENTIAL_COOKIE_PATTERNS` in-place (ScrapingBee URL length optimization, script-specific).
- **Acceptance criteria:**
  - VERIFY: `grep -c "COOKIE_DOMAIN_MAP" scripts/recollect-for-scores.js` returns 0
  - VERIFY: `node scripts/recollect-for-scores.js --help 2>&1 || true` doesn't throw import errors

### Task S1-T6: Update export-cookies.js secret name references
- **Complexity:** S (5 domain configs, lines 40-71)
- **Depends on:** S1-T1
- **Parallel:** Yes
- **Files:** `scripts/export-cookies.js` (modify)
- **Description:** Update the `DOMAIN_CONFIG` to note that secrets are now in bundles. Update the "paste into GitHub Secrets" instructions to reference the bundle format. Import outlet→bundle mapping from cookie-loader if practical.
- **Acceptance criteria:**
  - VERIFY: `node scripts/export-cookies.js --help 2>&1 || true` doesn't throw

### Task S1-T7: Commit + push Sprint 1
- **Complexity:** S
- **Depends on:** S1-T1 through S1-T6
- **Parallel:** No
- **Files:** All modified files
- **Description:** Type-check, lint, commit all Sprint 1 changes. Push to main. Verify existing CI workflows still pass (they'll use individual env vars via backward compat).
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` passes
  - VERIFY: `npx next lint` passes
  - VERIFY: `git push` succeeds
  - VERIFY: `gh run list --limit 3` shows no failures on latest commit

---

## Sprint 2: Python Push Script + Bundle Secrets
**Goal:** extract-safari-cookies.py creates bundle secrets. Bundle secrets exist on GitHub alongside individual secrets.
**Demo:** `python3 scripts/extract-safari-cookies.py --push` creates 11 `COOKIES_BUNDLE_*` secrets.
**Risks:** Bin-packing exceeds 48KB for some combinations. Bundle format mismatch with loader expectations.
**MODEL:** Sonnet — well-defined transformation of existing script

### Task S2-T1: Update extract-safari-cookies.py to push bundles
- **Complexity:** M (bin-packing logic, ~50 lines)
- **Depends on:** None (can parallel with Sprint 1 — just needs to agree on bundle JSON schema: `{"outlet_key": [cookies...], ...}`)
- **Parallel:** Yes (Agent B)
- **Files:** `scripts/extract-safari-cookies.py` (modify)
- **Description:** Add bin-packing to `--push` mode. Group outlets into chunks that fit in 48KB base64-encoded. Push as `COOKIES_BUNDLE_1` through `COOKIES_BUNDLE_N`. Warn if any bundle >40KB (headroom). Error if a single outlet exceeds 48KB solo. Keep pushing individual secrets too during migration. Keep local file output unchanged.
- **Acceptance criteria:**
  - VERIFY: `python3 scripts/extract-safari-cookies.py --dry-run 2>&1 | grep "BUNDLE"` shows bundle plan
  - VERIFY: Each bundle <48KB in dry-run output
  - VERIFY: `python3 scripts/extract-safari-cookies.py --push` succeeds (run in Terminal with FDA)

### Task S2-T2: Push bundle secrets to GitHub
- **Complexity:** S (run the script)
- **Depends on:** S2-T1
- **Parallel:** No
- **Files:** None (GitHub secrets only)
- **Description:** Run the push script from Terminal (needs FDA). Verify all bundles created.
- **Acceptance criteria:**
  - VERIFY: `gh secret list | grep COOKIES_BUNDLE | wc -l` shows 11 (or however many)
  - VERIFY: No push failures in script output

### Task S2-T3: Verify bundles load correctly in cookie-loader
- **Complexity:** S
- **Depends on:** S1-T1, S2-T2
- **Parallel:** No
- **Files:** None
- **Description:** Trigger check-cookie-health workflow with both bundle AND individual secrets present. Confirm the loader picks up bundles.
- **Acceptance criteria:**
  - VERIFY: `gh workflow run check-cookie-health.yml` succeeds
  - VERIFY: Workflow logs show cookies loaded for all outlets

---

## Sprint 3: Workflow Migration
**Goal:** All 11 workflows pass `COOKIES_BUNDLE_*` env vars instead of 33 individual ones.
**Demo:** Trigger any workflow — it loads cookies from bundles.
**Risks:** Missing a step in dual-step workflows (hard-paywall, soft-paywall). CI lint-workflows regex may break.
**MODEL:** Sonnet — repetitive env var replacement across YAML files

### Task S3-T1: Update test.yml lint-workflows regex (if needed)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `.github/workflows/test.yml` (modify)
- **Description:** Check if `lint-workflows` job enforces patterns like `*_COOKIES` that would reject `COOKIES_BUNDLE_*`. Update regex to accept bundle format. If no enforcement exists, skip this task.
- **Acceptance criteria:**
  - VERIFY: `grep -A 20 "lint-workflows" .github/workflows/test.yml | grep -i cookie` — check if cookies pattern is enforced

### Task S3-T2: Update simple workflows (single cookie step)
- **Complexity:** M (6 files, mechanical replacement)
- **Depends on:** S2-T2
- **Parallel:** Yes
- **Files:** `check-cookie-health.yml`, `collect-review-texts.yml`, `collect-free-reviews.yml`, `bulk-collect-review-texts.yml`, `rescrape-truncated.yml`, `collect-we-ob-reviews.yml`
- **Description:** Replace 33 individual `*_COOKIES: ${{ secrets.X }}` env var lines with ~11 `COOKIES_BUNDLE_*: ${{ secrets.COOKIES_BUNDLE_* }}` lines. These workflows have single steps that use cookies.
- **Acceptance criteria:**
  - VERIFY: `grep -l "WSJ_COOKIES" .github/workflows/*.yml | wc -l` decreases by 6
  - VERIFY: `grep -l "COOKIES_BUNDLE" .github/workflows/*.yml | wc -l` increases by 6
  - VERIFY: `npx tsc --noEmit && npx next lint` still pass

### Task S3-T3: Update dual-step workflows
- **Complexity:** M (3 files, 2 steps each — easy to miss one)
- **Depends on:** S2-T2
- **Parallel:** Yes (can parallel with S3-T2)
- **Files:** `collect-hard-paywall.yml`, `collect-soft-paywall.yml`, `opening-night-poller.yml`
- **Description:** Same replacement as S3-T2 but verify BOTH the collect step AND the rescrape/recollect step are updated. Opening-night-poller may have multiple jobs.
- **Acceptance criteria:**
  - VERIFY: `grep -c "WSJ_COOKIES\|NYT_COOKIES" .github/workflows/collect-hard-paywall.yml` returns 0
  - VERIFY: `grep -c "COOKIES_BUNDLE" .github/workflows/collect-hard-paywall.yml` shows matches in both steps

### Task S3-T4: Update remaining workflows
- **Complexity:** S (2 files, small cookie footprint)
- **Depends on:** S2-T2
- **Parallel:** Yes
- **Files:** `recollect-for-scores.yml`, `recover-wsj-subscriber.yml`
- **Description:** Same replacement. recover-wsj-subscriber.yml has 2 steps using WSJ_COOKIES (lines 38, 83).
- **Acceptance criteria:**
  - VERIFY: `grep -c "WSJ_COOKIES\|TELEGRAPH_COOKIES" .github/workflows/recollect-for-scores.yml .github/workflows/recover-wsj-subscriber.yml` returns 0

### Task S3-T5: Commit + push + verify CI
- **Complexity:** S
- **Depends on:** S3-T1 through S3-T4
- **Parallel:** No
- **Files:** All modified workflow files
- **Description:** Commit all workflow changes. Push. Wait for test.yml CI to pass. Trigger check-cookie-health to verify bundles work end-to-end.
- **Acceptance criteria:**
  - VERIFY: `gh run list --limit 5` shows test.yml passing
  - VERIFY: `gh workflow run check-cookie-health.yml` — wait for success

### Task S3-T6: E2E test collect-review-texts in CI
- **Complexity:** S
- **Depends on:** S3-T5
- **Parallel:** No
- **Files:** None
- **Description:** Trigger a real collect run for a single show to verify cookies load from bundles in CI. Use a show with paywalled reviews (e.g., giant-2026 for NYT/WSJ).
- **Acceptance criteria:**
  - VERIFY: `gh workflow run collect-review-texts.yml -f show_id=giant-2026` — logs show "Loaded N cookies for wsj.com from bundle"

---

## Sprint 4: Cleanup
**Goal:** Remove old individual secrets, freeing 22+ secret slots.
**Demo:** `gh secret list | wc -l` shows ~78 (down from 100).
**Risks:** Deleting a secret that something still references.
**MODEL:** Sonnet — mechanical cleanup

### Task S4-T1: Verify all workflows have run successfully with bundles
- **Complexity:** S
- **Depends on:** S3-T5, S3-T6
- **Parallel:** No
- **Files:** None
- **Description:** Check `gh run list` for each workflow file. Confirm at least one successful run after the Sprint 3 merge. Don't proceed until all have passed.
- **Acceptance criteria:**
  - VERIFY: `gh run list --workflow=check-cookie-health.yml --limit 1 --json conclusion -q '.[0].conclusion'` returns "success"
  - VERIFY: Same check for collect-review-texts.yml and at least 2 other workflows

### Task S4-T2: Delete old individual cookie secrets
- **Complexity:** S
- **Depends on:** S4-T1
- **Parallel:** No
- **Files:** None
- **Description:** Delete all 33 individual `*_COOKIES` secrets. Also remove backward-compat individual env var fallback from cookie-loader.js (optional — can keep for local dev convenience). Remove `--push` individual secret logic from extract-safari-cookies.py.
- **Acceptance criteria:**
  - VERIFY: `gh secret list | grep "_COOKIES" | grep -v "BUNDLE" | wc -l` returns 0
  - VERIFY: `gh secret list | wc -l` shows ~78 or fewer
  - VERIFY: `gh workflow run check-cookie-health.yml` still succeeds after deletion

---

## Dependencies Graph
```
S1-T1 ──> S1-T2 ──> S1-T7
  │   ──> S1-T3 ──/
  │   ──> S1-T4 ──/
  │   ──> S1-T5 ──/
  │   ──> S1-T6 ──/
  │
S2-T1 ──> S2-T2 ──> S2-T3 ──> S3-T2 ──> S3-T5 ──> S3-T6 ──> S4-T1 ──> S4-T2
                               S3-T3 ──/
                     S3-T1 ──> S3-T4 ──/
```

## Parallel Execution Map
```
Agent A:  S1-T1 → S1-T2 → S1-T3 → S1-T4 → S1-T5 → S1-T6 → S1-T7
Agent B:  S2-T1 (parallel w/ Sprint 1, agree on bundle JSON schema upfront)
Agent C:  Audit all 11 workflow env var mappings (prep for Sprint 3)
Sync:     ──── after S1-T7 + S2-T1 ──── S2-T2 + S2-T3 ──── S3 ──── S4 ────
```

**Parallel sprints:** Sprint 1 and S2-T1 can run simultaneously.
**Critical path:** S1-T1 → S1-T2 → S1-T7 → S2-T2 → S2-T3 → S3-T5 → S3-T6 → S4-T2 (8 tasks)
**Max parallelism:** 3 agents during Sprint 1 / S2-T1 phase

## Known Edge Cases
- **THR vs hollywoodreporter:** Env var is `THR_COOKIES`, file key is `hollywoodreporter`. Loader mapping must handle this.
- **PMC shared cookies:** Variety, Deadline, Hollywood Reporter, IndieWire share `.pmc.com` cookies. Bundling shouldn't break cross-domain cookie matching.
- **Bundle size drift:** As users add more cookie consent, individual outlet sizes grow. Bin-packing should have 10-15% headroom.
- **macOS Tahoe cookie path:** Already fixed in extract-safari-cookies.py (sandboxed container path).

## Changes from Critique
| Change | Reason | Source |
|--------|--------|--------|
| Each wiring task (S1-T2 to T5) has its own verify step | Don't batch-discover failures after all wiring done | Critique #1 |
| Added S2-T3 (verify bundles in CI before workflow migration) | Dangerous gap between pushing bundles and using them | Critique #2 |
| Split S3 into simple/dual-step/remaining batches | Reduce blast radius of workflow changes | Critique #3 |
| Added S4-T1 gate before secret deletion | Don't delete secrets until all workflows proven working | Critique #4 |
| Added 48KB headroom warning in S2-T1 | Prevent future breakage as cookies grow | Critique #6 |
| Added S3-T1 for test.yml lint-workflows check | CI may reject new env var naming pattern | Critique #7 |

## Key Risks
1. **Workflow migration blast radius** — 11 files changing env vars simultaneously. Mitigated by batching (simple first, dual-step second) and gating deletion on success.
2. **Bundle size exceeding 48KB** — Some outlets have large cookie jars (Vulture: 95, Chicago Tribune: 74). Mitigated by bin-packing with headroom warnings.
3. **Terminal FDA dependency** — Push script must run from Terminal (not Warp) on Mac Studio due to macOS Tahoe sandboxing. Document this clearly.
