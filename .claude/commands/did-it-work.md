You built it and it compiles. But does it actually work? And did you break anything nearby? 3-minute hands-on check.

## When to use

Run `/did-it-work` right after implementing and passing `/build-check`. The workflow is:
1. [implement]
2. `/build-check` — does it compile, lint, build?
3. **`/did-it-work`** — does it actually work? any collateral damage?
4. `/ship-check` — full QA (later, when ready to ship)

`/build-check` catches build errors. `/did-it-work` catches "it builds but it's broken." `/ship-check` catches the subtle stuff.

## Instructions

### Phase 0: Detect project type

```bash
if [ -f "app.json" ] && grep -q "expo" app.json 2>/dev/null; then
  echo "PROJECT_TYPE: expo"
elif [ -f "next.config.js" ] || [ -f "next.config.ts" ] || [ -f "next.config.mjs" ]; then
  echo "PROJECT_TYPE: nextjs"
else
  echo "PROJECT_TYPE: generic"
fi
```

### Phase 1: What changed?

Identify what was just built:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent implementation work in the conversation

```bash
git diff --name-only HEAD~3 2>/dev/null || git diff --name-only origin/main
```

Categorize changes:
- **New code:** files created or heavily modified
- **Touched code:** files with small edits (imports, params, config)
- **Affected routes:** map changed files to the pages/routes they affect:
  **Next.js:**
  - `src/app/**/page.tsx` → the route itself
  - `src/components/*` → grep for imports to find which pages use them
  - `scripts/*` → which workflows or data pipelines call them
  - `data/*` → which pages consume this data
  **Expo:**
  - `app/(tabs)/*.tsx` → the tab screen itself
  - `app/show/[slug].tsx` → show detail page
  - `app/rate/[showId].tsx` → rating sheet
  - `components/*` → grep for imports to find which screens use them
  - `lib/*`, `hooks/*` → grep for imports to find which screens/components use them
- **Blast radius:** files that import from or depend on changed files (check top 3-5 with `grep -r`)

### Phase 2: Test the happy path

Actually exercise the thing that was built. Don't just read the code — run it.

**MANDATORY TESTING RULES (non-negotiable):**
1. **Real data only.** Use data from `data/` directory or production. Never synthetic, never mocked, never "example" data you made up.
2. **Minimum 3 diverse cases.** Not 3 copies of the happy path. Pick cases that differ meaningfully:
   - A normal case (happy path)
   - An edge case (empty data, missing fields, null values, no category, no reviews)
   - A boundary case (oldest show, newest show, show with most reviews, different market)
3. **Before/after comparison (when modifying existing behavior).** Run old code on sample input → save output. Run new code on same input → diff. If outputs differ in ways you didn't intend, you have a bug.
4. **`node --check` and `tsc` are NOT tests.** They check syntax and types. They do not prove your code works. You must execute the actual code path against real data.

**For UI changes:**
- Use deployed preview URL (preferred) or running dev server. Don't start a new dev server just for this — Next.js compiles 60-90s/page.
- Click/tap through the primary user flow on the affected page
- Verify data displays correctly (spot-check 3 specific items against source data, including 1 edge case)
- Do NOT screenshot every page — that's `/ship-check`'s job. Just verify the thing you changed works.
- **Check for JS errors** on affected pages:
  ```bash
  npx playwright test --browser=chromium -e "
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
    await page.goto('PAGE_URL');
    await page.waitForTimeout(2000);
    console.log(errors.length ? 'ERRORS: ' + JSON.stringify(errors) : 'No JS errors or failed requests');
  "
  ```
  Or use Playwright MCP if available: navigate to the page and check console output.

**For interactive flows (UGC, auth, lists, diary):**

**Next.js:** Use Playwright MCP or script to test the actual user flow:
  - Add/remove from watchlist → verify state persists on reload
  - Add show to list → verify it appears in the list
  - Rate a show → verify the rating displays
  - Sign in → verify auth state carries across pages

**Expo:** Use Maestro to test the affected flow:
  - `maestro test .maestro/show-rating/save-flow.yaml` (rating)
  - `maestro test .maestro/my-shows/` (watchlist/diary)
  - `maestro test .maestro/tabs/` (navigation)
  - For flows without Maestro coverage: manual test in simulator, note test gap

These flows have state — a screenshot can't catch a broken mutation.

**For scripts/pipelines:**
- Run the script on at least 3 real inputs (not `--limit 1` and done — pick diverse cases)
- Check the output matches expectations for each case
- Verify output files are written where expected
- If modifying existing logic: run old version on same inputs first, diff against new output

**For scoring-logic changes (MANDATORY gate — non-negotiable):**
If any of these files appear in the diff — `src/lib/scoring.ts`, `src/lib/engine.ts`, `src/lib/data-core.ts`, `scripts/lib/rebuild-helpers.js`, `scripts/lib/score-extractors.js`, `scripts/lib/review-normalization.js`, `scripts/lib/review-guards.js` — run BOTH before the TESTED block:
```bash
node scripts/scoring-delta.js
node scripts/test-temporal-override-regression.js
```
Paste the summary output. If `scoring-delta.js` shows bucket shift >5% or mean drift >5pts, that is a blocker — do not proceed. Also grep for stale hardcoded weight values in non-canonical files: `grep -r "0\.35\|0\.75\|1\.0" src/ scripts/ --include="*.ts" --include="*.js" | grep -v "scoring\.ts\|outlet-tiers\.js\|node_modules"`.

**For data changes:**
- Query the affected data: `npm run db:build && node scripts/query.js "SELECT ..."`
- Spot-check 3 specific records against source

**For API/backend changes:**
- Hit the endpoint with a real request
- Check response shape and values

Report: does the happy path work? Yes/no with evidence.

### Phase 3: Check for collateral damage

This is the part that gets skipped. For each file in the "blast radius":

1. **Unintended changes in diff** (did-it-work's core differentiator — neither `/build-check` nor `/ship-check` focuses on this):
   ```bash
   git diff --stat
   ```
   If any file in the diff wasn't part of your plan, investigate it. Auto-formatted files? Data files modified? Config accidentally changed?

2. **Imports:** Did you rename, remove, or change the signature of anything exported? Check the top 3-5 consumers.
   ```bash
   # For each modified export, find importers
   grep -r "from.*CHANGED_FILE" src/ --include="*.ts" --include="*.tsx"
   ```

3. **Shared components:** If you changed a component used on multiple pages, spot-check 1 other page that uses it.

4. **Data shape:** If you changed a data structure, check 1-2 downstream consumers. Did you add a required field that existing data doesn't have?

### Phase 4: Report

You MUST include a TESTED evidence block. This is not optional. If you cannot fill it in, you have not tested.

```
━━━ TESTED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Real data: [yes/no — what data source]
Cases tested: [list each case with 1-line result]
  1. [normal case] → [result]
  2. [edge case] → [result]
  3. [boundary case] → [result]
Before/after diff: [yes/no/not applicable — summary if yes]
Production verified: [yes/no/not yet deployed — URL checked]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Happy path:** [works / broken — with evidence]

**Collateral damage found:**
- [issue 1 — what's affected and how]
- [issue 2]
- (or "None found")

**Unintended changes in diff:**
- [file — what happened]
- (or "Diff is clean")

**Verdict:** "Working clean" / "Happy path works but N side effects found" / "Broken — [what's wrong]"

**If working clean or side effects fixed:** proceed to `/ship-check` without waiting for the user to ask. The flow is: did-it-work → ship-check → wrap-up. Keep going.

### Fix every issue you found

**Fix every issue, in this session, right now.** Don't document and move on. Don't ask the user which to fix. Don't offer to "hand off to a new session." Handoff offers are how sessions stop early — they are banned.

The only valid reasons to not fix something now:
- Genuinely blocked: needs a user decision between real alternatives, missing credentials, requires a different repo, would push the session past ~2 hours
- In all other cases: **fix it.** A "30-minute derail" is not a blocker — that's just the work.

For anything truly blocked, add a self-contained Notion card (per `feedback_notion_card_context.md`) — and if it's technical + self-contained, dispatch it yourself (`node scripts/bsc-next.js --id <task#>` in Broadwayscore, ending with a `DISPATCHED:` line) instead of leaving a paste-prompt — then KEEP WORKING on what you can. Never end the loop with a question to the user when there is more work you can do.
