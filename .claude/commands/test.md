Automated test gate. Run this BEFORE committing any code changes. Catches TypeScript errors, lint issues, build failures, and script bugs before they reach production.

## When to use

Run `/test` after writing code but before committing. This is the minimum bar — every commit must pass.
- After implementing a feature or fix
- Before pushing to main (which triggers deploy)
- When you're unsure if your changes broke something

**Workflow:** Implement → **`/test`** → Commit → Push

## Instructions

### Phase 1: Identify scope

Determine what was changed:
1. Run `git diff --stat` to see modified files
2. Categorize: `src/` (frontend), `scripts/` (backend), config, data, workflows

### Phase 2: Core checks (run ALL in parallel)

Run all of these simultaneously via Bash:

1. **TypeScript check:** `npx tsc --noEmit 2>&1 | tail -30`
2. **Lint check:** `npx next lint 2>&1 | tail -30`
3. **Data validation:** `node scripts/validate-data.js 2>&1 | tail -20`
4. **Build test:** `npm run build 2>&1 | tail -30`

**Evaluation rules:**
- TypeScript errors in files YOU changed → P0 blocker, must fix
- TypeScript errors in other files → note as pre-existing, not a blocker
- Lint warnings in files YOU changed → P1, should fix
- Build failure → P0 blocker, must fix
- Data validation issues → only a blocker if your changes caused them

### Phase 2b: Bundle size check (if `src/` files changed)

After the build succeeds, check bundle sizes against baseline:
```
node scripts/check-bundle-size.js
```

**Evaluation:**
- Any page exceeding 200kB absolute cap → P0 blocker
- Shared JS grew >5kB → P1, investigate what was added
- Any page grew >10kB → P1, investigate (did you add a heavy dependency? inline data that should be loaded client-side?)
- If regressions are justified (new feature adds necessary weight), update baseline: `node scripts/check-bundle-size.js --update-baseline`

**NOTE:** The build in Phase 2 step 4 already ran — the bundle size script will re-run it. To avoid double-building, you can skip the Phase 2 build and let this step handle it, or run both checks from the same build output.

### Phase 3: Functional verification (based on what changed)

**If `src/` files changed (frontend):**
- Start dev server: `PORT=3456 npm run dev > /tmp/dev-server.log 2>&1 &` (wait 4s)
- Screenshot affected pages at mobile (390x844) and desktop (1440x900) using `npx playwright screenshot --browser=chromium`
- Verify: correct text/copy, no layout breaks, proper market/category awareness
- Kill server when done: `kill $(lsof -ti:3456) 2>/dev/null`

**If `scripts/` files changed (backend):**
- Run the script with `--dry-run` if supported, or write a quick inline test
- Test with real data from `data/` directory — never test with mocked/fake data
- For email templates: call the function with both `broadway` and `west-end` market params, verify output contains correct branding
- For data scripts: verify output JSON is valid and matches expected schema

**If workflow `.yml` files changed:**
- Run `actionlint .github/workflows/CHANGED_FILE.yml 2>&1` if actionlint is available
- Verify env vars and secrets are referenced correctly
- Check `if:` conditions and step dependencies

### Phase 4: Report

Present results:

**PASS** — All checks pass. Safe to commit.

**FAIL** — List each failure with:
- What failed (TypeScript/lint/build/functional)
- Exact error message
- Whether it's from your changes or pre-existing
- Fix required before committing

Then fix all failures from your changes and re-run the failing checks to confirm.

### Phase 5: Systematic prevention check

After fixing any failures, ask: **"Could this class of bug have been prevented automatically?"**

If yes, implement the prevention:
- Missing type → add proper TypeScript types
- Undefined reference → add to a constants file or barrel export
- Market-unaware code → add market param with default fallback
- Template mismatch → add a simple test script that exercises all code paths

**The goal is zero recurring bugs.** Every fix should also fix the class of problem, not just the instance.
