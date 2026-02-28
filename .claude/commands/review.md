Post-implementation QA review. Run this AFTER code is written but BEFORE shipping to production. Catches data bugs, visual regressions, and UX issues that the implementing session missed.

## When to use

Run `/review` after completing a feature or significant change, before deploying. The workflow is:
1. Idea → `/sanity-check` → Plan → `/critique` → Implement → **`/review`** → Ship

`/sanity-check` catches wrong approaches. `/critique` catches bad plans. `/review` catches bugs in finished code.

**Use when:** A session just finished building something and you want to verify it's solid before shipping.

## Instructions

### Phase 1: Understand what was built

Identify what to review. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent completed work in the conversation

**Gather scope:**
1. Run `git diff main --stat` (or `git diff HEAD~N --stat` if on main) to see all changed files
2. Read the key changed files to understand what was built
3. Identify which pages/routes are affected
4. Note any new data files or schema changes

Write a brief scope summary: what changed, which pages are affected, what data is involved.

### Phase 2: Automated checks (run ALL in parallel)

Run all of these simultaneously via Bash:

1. **TypeScript check:** `npx tsc --noEmit 2>&1 | tail -20`
2. **Lint check:** `npx next lint 2>&1 | tail -20`
3. **Data validation:** `node scripts/validate-data.js 2>&1 | tail -30`
4. **Build test:** `npm run build 2>&1 | tail -30` (catches SSG errors, missing imports, data issues at scale)

If any fail, report them immediately — these are P0 blockers. Do NOT continue to visual review until build passes.

### Phase 3: Data audit

This phase checks for data correctness and edge cases. Tailor the queries to what was built.

1. **Start the query engine:** `npm run db:build 2>&1 | tail -5`

2. **Run targeted queries** based on what changed. Examples:
   - New page showing shows: `node scripts/query.js "SELECT id, title, score FROM shows WHERE score IS NULL LIMIT 10"` — check null handling
   - New aggregation: query for min/max/avg values, look for outliers
   - New field: query for null/empty values, check coverage percentage
   - Sorting/ranking: verify the top and bottom items make sense

3. **Edge case sampling** — Query for the hardest cases:
   - Shows with no reviews, no score, no image
   - Shows in previews vs open vs closed
   - Shows with very long or very short titles
   - Historical shows (no score) vs scored shows
   - Any data the new feature depends on — check for nulls, unexpected values

4. **Accuracy spot-check** — Pick 3-5 specific items and verify the displayed data matches the source JSON files. Don't trust aggregated numbers without checking the inputs.

Report findings: what looks correct, what looks suspicious, what's clearly wrong.

### Phase 4: Visual audit

**Start dev server** (if not already running):
```
PORT=3456 npm run dev > /tmp/dev-server.log 2>&1 &
sleep 5
```

**Screenshot affected pages** on both mobile and desktop viewports. For EACH affected page:

```js
// Mobile (iPhone-sized)
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:390,height:844}});await p.goto('http://localhost:3456/PAGE',{waitUntil:'networkidle'});await p.screenshot({path:'/tmp/review-mobile-PAGE.png',fullPage:true});await b.close();})()"

// Desktop
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:900}});await p.goto('http://localhost:3456/PAGE',{waitUntil:'networkidle'});await p.screenshot({path:'/tmp/review-desktop-PAGE.png',fullPage:true});await b.close();})()"
```

**Also screenshot the SAME pages on production** for comparison:

```js
// Production mobile
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:390,height:844}});await p.goto('https://broadwayscorecard.com/PAGE',{waitUntil:'networkidle'});await p.screenshot({path:'/tmp/review-prod-mobile-PAGE.png',fullPage:true});await b.close();})()"

// Production desktop
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:900}});await p.goto('https://broadwayscorecard.com/PAGE',{waitUntil:'networkidle'});await p.screenshot({path:'/tmp/review-prod-desktop-PAGE.png',fullPage:true});await b.close();})()"
```

**Review all screenshots yourself** (use the Read tool on the PNG files). Check:

**Internal consistency (localhost):**
- Score badges: same size, position, and colors as other pages
- Card layouts: consistent spacing, alignment, no overflow
- Typography: consistent font sizes, weights, line heights
- Responsive: mobile version isn't just a squished desktop — check touch targets, text wrapping
- Empty states: what shows when data is missing? Is it graceful or broken?
- Toggle states: if there's a toggle (Critics/Audience, sort options), check ALL states

**Comparison to production:**
- Did any EXISTING elements move, shrink, grow, or disappear?
- Are shared components (nav, footer, score badges, status pills) identical?
- Is the new feature visually consistent with the established design language?
- Any regressions on pages that weren't supposed to change?

### Phase 5: UX review (run BOTH in parallel)

Launch both reviewers simultaneously. Save the screenshots to files that can be referenced.

1. **Claude subagent — Codebase-aware UX review** — Use the Task tool with subagent_type "general-purpose":

   > You are a QA engineer reviewing a just-completed feature. You have access to the codebase. Your job is to find bugs, edge cases, and UX issues that the developer missed.
   >
   > **DATA REVIEW:**
   > 1. Read the key source files for this feature. Check: are there any code paths that could produce wrong data? (wrong sort order, missing null checks, off-by-one errors, stale cache)
   > 2. Check edge cases in the actual data files. What's the weirdest/emptiest/most extreme data that this feature will encounter? Will it render correctly?
   >
   > **UX REVIEW:**
   > 3. Walk through the user journey on mobile. What do they tap? What do they see? What might confuse them?
   > 4. Is there anything that works but looks wrong? (e.g., correct data displayed in a misleading way, sort order that seems arbitrary, truncated text that hides important info)
   > 5. Accessibility: any contrast issues, missing alt text, touch targets too small?
   >
   > **REGRESSION CHECK:**
   > 6. Did any shared component get modified? If so, check 2-3 other pages that use it — did they break?
   > 7. Are there any new TypeScript `any` types, suppressed errors, or TODO comments that indicate shortcuts?
   >
   > Reference specific files and line numbers. Under 500 words. Bullet points only.
   >
   > WHAT WAS BUILT: [describe the feature and list key files]

2. **GPT-4o — Fresh-eyes UX review** — Run this curl command via Bash.
   **GPT-4o gets a description of the pages + what they should show, but NOT the code. It reviews from a pure user perspective.**
   ```
   curl -s https://api.openai.com/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $OPENAI_API_KEY" \
     -d "$(jq -n --arg context "$(cat /tmp/review-ux-context.txt)" '{
       model: "gpt-4o",
       temperature: 0.3,
       messages: [
         {role: "system", content: "You are a theater fan who just discovered broadwayscorecard.com on your phone. You have never seen the site before. You are NOT a developer — you are a user.\n\nYou will receive a description of pages you are looking at and what they are supposed to show.\n\n**YOUR TASKS:**\n\n1. **First impression:** What stands out? What is confusing? What would you tap first? Is it obvious what this page is for?\n\n2. **Information hierarchy:** Is the most important info the most prominent? Is anything buried that should be front and center? Is anything prominent that does not matter?\n\n3. **Trust signals:** Does this look professional or janky? Would you trust the scores? Is anything inconsistent that would undermine trust (different styles, misaligned elements, weird spacing)?\n\n4. **Missing expectations:** As a theater fan, what do you EXPECT to see that is not here? What question does this page raise but not answer?\n\n5. **The one thing:** If you could change ONE thing to make this page better for you as a user, what would it be?\n\nBe specific and opinionated. Under 400 words. Bullet points only."},
         {role: "user", content: ("Review these pages as a first-time user. What is confusing, missing, or wrong?\n\n" + $context)}
       ]
     }')" | jq -r '.choices[0].message.content'
   ```

   **Before running:** Write a UX context file to `/tmp/review-ux-context.txt` describing:
   - What pages exist and what they show (in plain language, not code)
   - What the user journey is (how do you get to these pages?)
   - What data is displayed and what it means
   - Any design choices that might be surprising

### Phase 6: Report

Present findings in a structured report:

**P0 — Blockers** (must fix before shipping):
- Build/lint/type errors
- Wrong data displayed
- Broken pages or crashes
- Regressions on existing pages

**P1 — Should fix** (fix now, low effort):
- Visual inconsistencies with rest of site
- Missing null/empty state handling
- Confusing UX that both reviewers flagged
- Accessibility issues

**P2 — Nice to have** (note for follow-up):
- Polish suggestions
- UX improvements only one reviewer flagged
- Edge cases that affect <1% of users

**Summary line:** "Ready to ship" / "Fix N P0 issues first" / "Fix N P0 + recommend fixing N P1 issues"

### Phase 7: Systematic fix analysis

**For every P0 and P1 issue found, answer TWO questions:**

1. **How do we fix this instance?** (the immediate fix)
2. **How do we prevent this CLASS of problem from ever recurring?** (the systematic fix)

This is critical — the user is non-technical and this system must be automated and set-and-forget. One-off fixes are wasted work if the same bug can happen again next time.

**Examples of systematic fixes:**
- Bug: undefined constant referenced → **Systematic:** Add `npx tsc --noEmit` to pre-commit checks, or add a test script that exercises all code paths
- Bug: function signature changed but callers not updated → **Systematic:** Add a grep-based check in `/test` that verifies all callers match expected signatures
- Bug: market-unaware code → **Systematic:** Add a code comment or TypeScript type that forces market to be passed, so forgetting it is a compile error not a runtime bug
- Bug: hardcoded "Broadway" in template → **Systematic:** Create a `getSiteName(market)` helper so branding is centralized, not scattered across files
- Bug: localStorage key collision → **Systematic:** Use TypeScript const enum or branded types for storage keys

**In the report, for each P0/P1, include:**
- **Fix:** [what to change]
- **Prevent:** [what to add/change so this can't happen again]

If the prevention requires a new test, script, or type — include it in the fix plan. Don't just note it for later.

### Phase 8: Clean up

Kill the dev server if you started one: `kill $(lsof -ti:3456) 2>/dev/null`

### Phase 9: Ask the user

Present the report and ask: "Ready to ship as-is, or should I fix the P0/P1 issues first? (Fixes will include systematic prevention.)"
