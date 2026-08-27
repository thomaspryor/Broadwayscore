The bugs that ship to production are the ones that pass every automated check. Two independent reviewers, a data audit, and visual QA find them.

## When to use

Run `/ship-check` after completing a feature or significant change, before deploying. The workflow is:
1. Idea → `/right-problem` → Plan → `/plan-review` → Implement → **`/ship-check`** → Ship

`/right-problem` catches wrong approaches. `/plan-review` catches bad plans. `/ship-check` catches bugs in finished code.

**MANDATORY for any feature or change that touches src/ files.** Do not skip this. Do not tell yourself "it's a small change." The bugs it catches are exactly the ones that seem too small to review. If you built something and are about to push, run `/ship-check` first.

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

**File conflict scan (MANDATORY for new files):** For every NEW file created, check:
- Does a build-time generator already produce this output? (e.g., Next.js `src/app/robots.ts` → `robots.txt`, `src/app/sitemap.ts` → `sitemap.xml`)
- Does another config file override or conflict? (e.g., `vercel.json` headers vs `next.config.js` headers vs middleware)
- Does this duplicate an existing file in a different location or format?
- For new workflows: does an existing workflow with overlapping cron/trigger already cover this?
Search: `grep -rl "FILENAME_STEM" src/ scripts/ .github/ public/` for each new file. Report conflicts as P0 blockers.

### Phase 1.5: Detect project type

```bash
if [ -f "app.json" ] && grep -q "expo" app.json 2>/dev/null; then
  echo "PROJECT_TYPE: expo"
elif [ -f "next.config.js" ] || [ -f "next.config.ts" ] || [ -f "next.config.mjs" ]; then
  echo "PROJECT_TYPE: nextjs"
else
  echo "PROJECT_TYPE: generic"
fi
```

### Phase 2: Automated checks (run ALL in parallel)

Run all of these simultaneously via Bash:

**Next.js:**
1. **TypeScript check:** `npx tsc --noEmit 2>&1 | tail -20`
2. **Lint check:** `npx next lint 2>&1 | tail -20`
3. **Data validation:** `node scripts/validate-data.js 2>&1 | tail -30`
4. **Build test (auth-aware):** Build with feature flags enabled, but only include `userAccounts` if Supabase env vars are present:
   ```bash
   if [ -n "$NEXT_PUBLIC_SUPABASE_URL" ]; then
     NEXT_PUBLIC_FEATURES=userAccounts,criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions npm run build 2>&1 | tail -30
   else
     echo "Skipping userAccounts flag (no NEXT_PUBLIC_SUPABASE_URL). Building with other flags."
     NEXT_PUBLIC_FEATURES=criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions npm run build 2>&1 | tail -30
   fi

**Expo:**
1. **TypeScript check:** `npx tsc --noEmit 2>&1 | tail -20`
2. **Lint check:** `npm run lint 2>&1 | tail -20`
3. **Export validation:** `npx expo export --platform ios 2>&1 | tail -30`
4. **E2E tests:** `npm run test:e2e 2>&1 | tail -30` (runs all Maestro suites)
   ```

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

### Phase 3.5: Statistical validity audit

This phase catches "technically correct but misleading" data — the kind of issue that's embarrassing when a user screenshots it for Reddit or social media. Numbers can be computed correctly but still mislead if based on insufficient data.

**For every ranking, average, or comparison displayed on affected pages, check:**

1. **Sample size floors**: What is the minimum number of data points that qualifies an entity for a ranking or average? If there is no minimum, flag it. An "average" of 1 data point is not an average — it's that data point. An "Nth highest-rated" ranking that includes single-data-point entries is meaningless.

2. **Population consistency**: When a threshold filters a list (e.g., "3+ shows"), verify it filters on the RIGHT field. Common bug: filtering on total count (e.g., total Broadway credits) but computing averages from a scored subset (e.g., only shows with critic reviews). A performer with 15 total credits but 1 scored show should not pass a "3+ shows" filter for score-based rankings.

3. **Rank denominator check**: For any "Nth best/most/highest" claim, check: what's the total pool being ranked? Is it filtered to a meaningful cohort? Is the threshold applied to scored items, not total items?

4. **SEO/structured data claims**: Check schema.org output (`application/ld+json` scripts) for `ratingCount`, `reviewCount`, `aggregateRating`. These go to Google and must be accurate. `ratingCount` should reflect actual scored items, not total items. Only emit `aggregateRating` when there are enough data points (3+) to be meaningful.

5. **Reddit screenshot test**: Query for the #1 and #2 entries at the top of any ranked list. Are they defensible? Would you post them on Reddit without hedging? If #1 has fewer than 3 data points, the ranking needs a minimum threshold or a sample-size indicator.

**How to run:**
- Read the ranking/sorting code. Find where thresholds are applied and what field they check.
- Write quick queries to find the extreme cases: who's #1? How many data points do they have? Who has the biggest gap between total items and scored items?
- Check if `showCount` vs `scoredShowCount` (or equivalent) is used correctly in filters, rankings, and SEO schemas.
- If the top entries are driven by 1-2 data points, flag it as P0.

Report findings: what thresholds exist, whether they're on the right fields, and any specific misleading entries.

### Phase 4: Visual audit

**Start dev server** (if not already running):
```
PORT=3456 npm run dev > /tmp/dev-server.log 2>&1 &
sleep 5
```

**Determine review scope** — check if this is a new page or a modification to existing pages:
- **New page** (route didn't exist before): Screenshot localhost only. No production comparison needed — there's nothing to compare against.
- **Modified existing page or shared component**: Screenshot BOTH localhost AND production for comparison.

**Screenshot affected pages** on both mobile and desktop viewports. For EACH affected page:

```bash
# Mobile (iPhone-sized)
npx playwright screenshot --browser=chromium --viewport-size=390,844 --full-page http://localhost:3456/PAGE /tmp/review-mobile-PAGE.png

# Desktop
npx playwright screenshot --browser=chromium --viewport-size=1440,900 --full-page http://localhost:3456/PAGE /tmp/review-desktop-PAGE.png
```

**Production comparison** (ONLY for modified existing pages or shared component changes):

```bash
# Production mobile
npx playwright screenshot --browser=chromium --viewport-size=390,844 --full-page https://broadwayscorecard.com/PAGE /tmp/review-prod-mobile-PAGE.png

# Production desktop
npx playwright screenshot --browser=chromium --viewport-size=1440,900 --full-page https://broadwayscorecard.com/PAGE /tmp/review-prod-desktop-PAGE.png
```

**Review all screenshots yourself** (use the Read tool on the PNG files). Check:

**Internal consistency (localhost):**
- Score badges: same size, position, and colors as other pages
- Card layouts: consistent spacing, alignment, no overflow
- Typography: consistent font sizes, weights, line heights
- Responsive: mobile version isn't just a squished desktop — check touch targets, text wrapping
- Empty states: what shows when data is missing? Is it graceful or broken?
- Toggle states: if there's a toggle (Critics/Audience, sort options), check ALL states

**Comparison to production (when applicable):**
- Did any EXISTING elements move, shrink, grow, or disappear?
- Are shared components (nav, footer, score badges, status pills) identical?
- Is the new feature visually consistent with the established design language?
- Any regressions on pages that weren't supposed to change?

### Phase 5: Multi-angle review (run ALL THREE in parallel)

Launch all three reviewers simultaneously. Save the screenshots to files that can be referenced.

1. **Claude subagent — Codebase-aware UX review** — Use the Task tool with subagent_type "general-purpose":

   > You are a QA engineer reviewing a just-completed feature. You have access to the codebase. Your job is to find bugs, edge cases, and UX issues that the developer missed.
   >
   > **DATA REVIEW:**
   > 1. Read the key source files for this feature. Check: are there any code paths that could produce wrong data? (wrong sort order, missing null checks, off-by-one errors, stale cache)
   > 2. Check edge cases in the actual data files. What's the weirdest/emptiest/most extreme data that this feature will encounter? Will it render correctly?
   >
   > **STATISTICAL VALIDITY:**
   > 3. For every ranking, average, or "Nth best" claim: what is the minimum sample size? Is the threshold checking the right field (e.g., scored items vs total items)? Query for the #1 entry — is it based on sufficient data?
   > 4. Would the top entries on any ranked list survive scrutiny if screenshotted and posted to social media? Check for single-data-point "averages" and misleading comparisons.
   >
   > **UX REVIEW:**
   > 5. Walk through the user journey on mobile. What do they tap? What do they see? What might confuse them?
   > 6. Is there anything that works but looks wrong? (e.g., correct data displayed in a misleading way, sort order that seems arbitrary, truncated text that hides important info)
   > 7. Accessibility: any contrast issues, missing alt text, touch targets too small?
   >
   > **REGRESSION CHECK:**
   > 8. Did any shared component get modified? If so, check 2-3 other pages that use it — did they break?
   > 9. Are there any new TypeScript `any` types, suppressed errors, or TODO comments that indicate shortcuts?
   >
   > Reference specific files and line numbers. Under 500 words. Bullet points only.
   >
   > WHAT WAS BUILT: [describe the feature and list key files]

2. **gpt-5.4-mini — Fresh-eyes UX review** — Run this curl command via Bash.
   **OpenAI check:** Run `echo ${OPENAI_API_KEY:+SET}` first.
   - If SET: run the curl, then **check the response** — if it's empty or `echo "$RESP" | jq -e '.error'` matches (bad key, quota, blocked host), do NOT swallow it. Print the error and record gpt-5.4-mini as **FAILED** in the coverage banner (Phase 6). A present key that errors is a real problem the user must see, not a silent Claude fallback.
   - If empty: this is a fixable misconfiguration, not a routine fallback. In a cloud session, add `OPENAI_API_KEY` in the environment settings at claude.ai/code (cloud icon → gear → Environment variables), and make sure Network access is **Full** or its Custom allowlist includes `api.openai.com`. Fall back to a Claude agent with the same system prompt so the review still runs, but record gpt-5.4-mini as **MISSING** in the coverage banner and surface it prominently.
   **gpt-5.4-mini gets a description of the pages + what they should show, but NOT the code. It reviews from a pure user perspective.**
   ```
   curl -s https://api.openai.com/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $OPENAI_API_KEY" \
     -d "$(jq -n --arg context "$(cat /tmp/review-ux-context.txt)" '{
       model: "gpt-5.4-mini",
       temperature: 0.3,
       messages: [
         {role: "system", content: "You are a theater fan who just discovered broadwayscorecard.com on your phone. You have never seen the site before. You are NOT a developer — you are a user.\n\nYou will receive a description of pages you are looking at and what they are supposed to show.\n\n**YOUR TASKS:**\n\n1. **First impression:** What stands out? What is confusing? What would you tap first? Is it obvious what this page is for?\n\n2. **Information hierarchy:** Is the most important info the most prominent? Is anything buried that should be front and center? Is anything prominent that does not matter?\n\n3. **Trust signals:** Does this look professional or janky? Would you trust the scores? Is anything inconsistent that would undermine trust (different styles, misaligned elements, weird spacing)?\n\n4. **Missing expectations:** As a theater fan, what do you EXPECT to see that is not here? What question does this page raise but not answer?\n\n5. **The one thing:** If you could change ONE thing to make this page better for you as a user, what would it be?\n\n6. **Would you screenshot this?** If you took a screenshot of the top of any ranked list and posted it to Reddit or Twitter, would anyone reply 'but that is only based on 1 show' or 'that average is meaningless'? If any ranking or average looks like it could be challenged for having too little data behind it, flag it.\n\nBe specific and opinionated. Under 500 words. Bullet points only."},
         {role: "user", content: ("Review these pages as a first-time user. What is confusing, missing, or wrong?\n\n" + $context)}
       ]
     }')" | jq -r '.choices[0].message.content'
   ```

   **Before running:** Write a UX context file to `/tmp/review-ux-context.txt` describing:
   - What pages exist and what they show (in plain language, not code)
   - What the user journey is (how do you get to these pages?)
   - What data is displayed and what it means
   - Any design choices that might be surprising

3. **Codex (GPT-5.x with codebase access) — Adversarial design review** — Run via Bash.
   **Codex check:** Run `command -v codex >/dev/null && echo READY || echo MISSING`.
   - READY (local): **Step 1 — run Codex, writing its filtered output to a private per-run temp file** (never a shared fixed path — this machine routinely runs many parallel Claude Code sessions, and a shared `/tmp` path lets one session's stale or in-flight file be read as another session's result):
     ```bash
     set -o pipefail
     # No suffix after the X's — BSD mktemp (macOS) silently ignores a template
     # that doesn't end in X's and returns the literal (non-random) path instead
     # of erroring, which would reintroduce the exact shared-path collision this
     # is meant to avoid. `mktemp /tmp/foo.XXXXXX` is the portable form.
     export CODEX_OUT=$(mktemp /tmp/codex-review-output.XXXXXX)
     # Determine the base ref. Robust against detached HEAD, non-main default branches (dev/trunk), and shallow repos.
     DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
     [ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=main
     CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
     if [ "$CURRENT" = "$DEFAULT_BRANCH" ] || [ "$CURRENT" = "HEAD" ]; then
       # On default branch or detached: compare last 5 commits, falling back to root if shallow
       BASE=$(git rev-parse HEAD~5 2>/dev/null) || BASE=$(git rev-list --max-parents=0 HEAD | head -1)
     else
       BASE="$DEFAULT_BRANCH"
     fi
     if [ -z "$BASE" ]; then echo "ERROR: could not determine base ref"; exit 1; fi
     {
       cat <<'PROMPT_HEAD'
     You are a senior engineer doing an adversarial pre-ship review. The diff below is about to be deployed. Your job is to find what's brittle, what's premature, and what assumptions are wrong — NOT to validate that it works.

     You have read access to the repository — use Read/Grep on the actual files. Cite specific files and line numbers.

     Do NOT run `npm run data:check`, `npm install`, `setup-local-data.sh`, or any other setup/preflight command — this is a pure read-only review of the diff below, no show/review data is needed, and worktree sessions do not have the full local data clone available. If CLAUDE.md's session-start convention would normally tell you to run a data-check preflight, that convention does not apply here: read the diff and the repository files directly and review them.

     **CHALLENGE THE DESIGN:**
     1. Was this the right approach? Is there a simpler one that was skipped? (config change vs new code, existing helper vs new function, deletion vs addition)
     2. What hidden assumption does this make that future-you will regret? (data shape, API contract, ordering, idempotency)
     3. What edge case does the surrounding code already handle that THIS code does not? Find the analogous pattern that already exists and the way the diff diverges from it.
     4. What's the rollback story? If this ships and breaks production at 2am, what's the path back? Is rollback safe or does it leave half-written state?

     **CHALLENGE THE INTEGRATION:**
     5. Race conditions: are there any concurrent paths (parallel CI, multiple workflows, user actions) that hit the same resource the diff touches? What happens if they collide?
     6. Backwards compatibility: does this break any existing data, route, query, or API consumer? Search for callers/readers/writers of anything the diff changed.
     7. Failure modes: list 3 concrete scenarios where this code does the wrong thing silently. (Not crashes — silent wrongness.) For each, what would the user see?

     Reference specific files (path:line) for every finding. No generic advice. Under 600 words. Bullet points only.

     THE DIFF TO REVIEW:
     PROMPT_HEAD
       git diff "$BASE"...HEAD -- src/ scripts/ public/ data/ 2>/dev/null | head -2000
       echo
       echo "=== UNCOMMITTED CHANGES ==="
       git diff HEAD -- src/ scripts/ public/ data/ 2>/dev/null | head -1000
     } | codex exec --sandbox read-only --skip-git-repo-check --color never -C "$PWD" 2>&1 \
       | awk '/^codex$/{flag=1; next} /^tokens used$/{flag=0} flag' \
       | tee "$CODEX_OUT"
     ```
     Note: uses your local Codex CLI (counts against ChatGPT Codex quota). For very large diffs, raise the `head -2000` cap.

     **Step 2 — validate the output before trusting it** (task #1081 — `codex exec` has exited 0 with zero bytes of output while `command -v codex` reports READY; exit code and CLI presence do not prove the reviewer said anything. Task #1320 — a well-formed REFUSAL, e.g. "Blocked by required data preflight... I must stop rather than review without data," is long non-empty prose and must not be mistaken for a genuine zero-findings review). Run this immediately after Step 1, in the same shell so `$CODEX_OUT` is still set:
     ```bash
     CODEX_CHECK=$(node -e "
       const { checkReviewOutput } = require('./scripts/lib/review-output-guard.js');
       const fs = require('fs');
       const text = fs.readFileSync(process.env.CODEX_OUT, 'utf-8');
       const { usable, kind, reason } = checkReviewOutput(text);
       console.log(kind);
       console.log(reason);
       process.exit(usable ? 0 : 1);
     ")
     CODEX_STATUS=$?
     CODEX_KIND=$(echo "$CODEX_CHECK" | head -1)
     CODEX_REASON=$(echo "$CODEX_CHECK" | tail -n +2)
     if [ "$CODEX_STATUS" -eq 0 ]; then echo CODEX_USABLE
     elif [ "$CODEX_KIND" = "refused" ]; then echo "CODEX_REFUSED: $CODEX_REASON"
     else echo "CODEX_EMPTY: $CODEX_REASON"; fi
     rm -f "$CODEX_OUT"
     ```
     If `CODEX_EMPTY` or `CODEX_REFUSED`: this is a coverage FAILURE, not a pass with nothing to say — do NOT report Codex as having run. Fall through to the exact same gpt-5.4-mini fallback used for MISSING below, and record in the coverage banner that Codex was READY but returned unusable output — `CODEX_EMPTY` means the CLI produced no text (task #1081, flaky-empty-output, not a missing CLI); `CODEX_REFUSED` means Codex explicitly declined to review (task #1320, e.g. blocked by a failed data preflight) — print the `$CODEX_REASON` in the banner either way so it's clear WHY coverage degraded.
   - MISSING (expected in cloud — there is no Codex CLI): do NOT drop to a Claude reviewer, which would leave **zero** non-Claude adversarial review. Instead run this SAME adversarial prompt + diff against **gpt-5.4-mini via `api.openai.com`** — reuse reviewer 2's curl mechanics (write `PROMPT_HEAD` + the diff to a temp file, send it as the `user` message, `model: "gpt-5.4-mini"`, check `jq -e '.error'` and surface any error). This preserves a real GPT-family adversarial reviewer. Only if `OPENAI_API_KEY` is also unavailable, fall back to a Claude agent. Record which reviewer actually ran (Codex / gpt-5.4-mini / Claude) in the coverage banner.
   **This reviewer challenges the design from a different model family. It reads the diff and the surrounding code, then questions whether the chosen approach is right — not whether it's correct.**

### Phase 6: Report

Present findings in a structured report.

**Reviewer coverage (print this FIRST — a degraded review is NOT a passed review):**
State exactly which of the three reviewers ran and on which model: (1) Claude codebase review, (2) fresh-eyes UX — GPT-4o or Claude fallback, (3) adversarial design — Codex / GPT-4o / Claude fallback. If any external-model reviewer did not run on its intended model, print a `⚠️` line naming what's missing and the one-line fix (usually: set the key, or set Network to Full). If reviewer 3 hit `CODEX_EMPTY` (Codex CLI present, exited 0, but produced no usable text — task #1081) or `CODEX_REFUSED` (Codex explicitly declined to review, e.g. a failed data preflight — task #1320), the `⚠️` line must say so explicitly, e.g. `⚠️ Codex ran but returned empty output (CLI flake, not missing) — fell back to gpt-5.4-mini` or `⚠️ Codex refused to review (blocked by data preflight) — fell back to gpt-5.4-mini`; do not fold either into a bare "reviewed, no findings" line, since an empty/refused-but-"passing" Codex run and a real zero-findings Codex run must never look identical. Do NOT print "Ready to ship" with full confidence when fewer than the intended external models ran — instead write e.g. "Ready to ship (reviewed with 2/3 model perspectives — GPT-family missing, see ⚠️)".

**P0 — Blockers** (must fix before shipping):
- Build/lint/type errors
- Wrong data displayed
- Broken pages or crashes
- Regressions on existing pages
- Rankings/averages based on 1-2 data points with no minimum threshold (embarrassing if screenshotted)
- SEO structured data with incorrect counts (ratingCount, reviewCount)

**P1 — Should fix** (fix now, low effort):
- Visual inconsistencies with rest of site
- Missing null/empty state handling
- Confusing UX that both reviewers flagged
- Accessibility issues
- Thresholds filtering on wrong field (total items vs scored items)

**P2 — Nice to have** (note for follow-up):
- Polish suggestions
- UX improvements only one reviewer flagged
- Edge cases that affect <1% of users

**Summary line:** "Ready to ship" / "Fix N P0 issues first" / "Fix N P0 + recommend fixing N P1 issues"

### Phase 7: Clean up

Kill the dev server if you started one: `kill $(lsof -ti:3456) 2>/dev/null`

### Phase 8: Fix every P0 and P1

**Fix all P0 and P1 issues now, in this session.** Don't report and stop. Don't ask the user which to do first. Don't offer to "hand off to a new session" — handoff offers are banned, they're how sessions die mid-task.

The only valid reasons to defer:
- Needs a user decision between real alternatives (not just permission to proceed)
- Missing credentials or access you can't obtain
- Different repo
- Would push the session past ~2 hours

"Would take 30 minutes" is not a blocker. "Is non-trivial" is not a blocker. Just do the work.

For anything genuinely blocked: card it in Notion (per `feedback_notion_card_context.md`), and if it's technical + self-contained, DISPATCH it yourself (`node scripts/bsc-next.js --id <task#>` in Broadwayscore, ending with a `DISPATCHED:` line) rather than leaving it as a paste-prompt. KEEP WORKING on the rest. Never leave a found issue in limbo, and never end the loop with a question when there is more work you can do.

**After all issues are resolved — record the verdict (BWSC repo, MANDATORY):**

```bash
node scripts/lib/review-gate.mjs --query=record --reviewer=ship-check --result=pass
```

(`--result=fail` if P0/P1s remain unfixed.) This writes the push-boundary breadcrumb (`.claude/review-verdicts.jsonl`) that `pre-push-review-gate.sh` checks on every `git push` touching >30 lines of src/scripts/workflow code. Without it the push is BLOCKED even though ship-check ran — the gate is prose-independent and only trusts the ledger. Run it from the worktree you reviewed in (the ledger lands at the canonical root automatically); if you fix findings after recording, re-run it so the verdict covers the fixed code.

**Then:** proceed to `/what-else` and then `/wrap-up` without waiting for the user to ask. The flow is: ship-check → record verdict → what-else → wrap-up. Keep going.

### Phase 9: Notion checkpoint (BWSC projects only)

Before proceeding to /what-else, verify the Notion card exists and is current:
1. Search for this session's "In progress" card
2. If found: update Notes with ship-check results (pass/fail, P0/P1 counts)
3. If NOT found: **stop and create it now** — this was a process failure (startup hook rule #1). Flag it to the user.

**⚠️ This is a mid-session checkpoint only.** The card is still "In progress". Final Status update (Done/Paused) happens in `/wrap-up`, which MUST run before the session ends. Do not skip wrap-up — orphaned "In progress" cards are a recurring problem.
