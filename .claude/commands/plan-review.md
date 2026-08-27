Most plans have serious gaps that a single reviewer won't catch. Six independent reviewers — covering correctness, structure, failure modes, consistency, user impact, AND code design — find almost all of them. The design reviewer is the one that catches plans that "work technically" but turn into tech debt within weeks.

## Instructions

### Phase 0: Approach validation check (MANDATORY — do not skip to Phase 2)

**Why this phase exists:** task #1218 (2026-08-10) — six reviewers passed a WE historical-backfill plan whose first gate was "5 shows through new tooling." None proposed the obviously wiser "2 shows by hand first." Every reviewer critiqued the plan AS FRAMED — hunting for missing guards inside the stated structure — because adversarial reviewers are tuned to find failure modes, not to shrink scope. The owner caught it in one read after the fact. This phase exists to force the framing challenge to happen BEFORE Phase 2, not rely on it emerging from six independent correctness lenses that were never asked to do it.

Before critiquing HOW this is built, answer these in writing (this is not optional scanning — write the answers, they get shown to the user in Phase 3):

1. **Has `/right-problem` actually been run?** Look for evidence in the conversation (reviewer outputs, approach recommendation) — not just "the plan looks considered." If it hasn't run and the plan represents >1 day of work (CLAUDE.md §10's own threshold), that is itself a Phase 0 finding: name it, don't silently proceed.
2. **State the plan's first real execution step in units** (N shows, N files, N records, N users, N dollars). Then answer directly: could this be 1-2 units, done mostly by hand, before any batch tooling or automation gets built? If yes, that IS a finding — write it as "the plan should ramp: 1-2 by hand → first tooling run → full scope," not as a suggestion buried in Phase 2 output.
3. **Is there a simpler approach nobody considered, or existing infrastructure being ignored?** (the original check — keep it.)
4. **Is there a do-nothing or do-less option this plan skipped past?** What breaks if the scope is half as large, or the plan is deferred a sprint?

If Phase 0 surfaces a scope/ramp/framing finding, put it at the TOP of Phase 3's output, before the six critiques — a framing fix found here changes what the six reviewers should even be reviewing. Don't let it get buried below or folded into the consensus table in Phase 4 (see the Phase 4 escalation rule).

If the approach is sound (or already validated) and the first-increment size is already minimal, say so explicitly and proceed.

### Phase 1: Gather the plan and context

Identify the plan to critique. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent plan or proposed changes in the conversation

**Generate a unique temp file for this run (prevents cross-contamination when plan-review runs in parallel):**
```bash
# No suffix after the X's — BSD mktemp (macOS) silently returns the literal,
# non-random template instead of erroring when a suffix follows the X's,
# which defeats the whole point of a unique per-session path on a machine
# that runs many parallel sessions (task #1081 finding).
PLAN_FILE=$(mktemp /tmp/critique-plan-XXXXXX)
echo "Plan file: $PLAN_FILE"
```
Remember this path — use `$PLAN_FILE` in ALL subsequent commands in this skill run (Codex guard, Gemini curl, etc.).

Write the plan text to `$PLAN_FILE`.

**Context enrichment:** If working in a codebase, add a brief context block at the top of the plan file describing:
- Tech stack (language, framework, deployment target)
- Data storage approach (database, files, etc.)
- Key constraints (bundle size limits, rate limits, API quotas, etc.)
- What already exists vs. what's new

This context prevents reviewers from giving generic advice that doesn't apply.

**Implementation conflict check (MANDATORY):** Before writing the plan file, for every file the plan CREATES or MODIFIES, search the codebase for existing equivalents:
- `grep -rl "FILENAME_STEM" src/ scripts/ .github/ public/` — does something already generate or manage this?
- Check for framework conventions that produce the same output (e.g., Next.js `src/app/robots.ts` generates `robots.txt`, `src/app/sitemap.ts` generates `sitemap.xml`, `src/app/manifest.ts` generates `manifest.json`)
- Check for config-level equivalents (e.g., headers in `vercel.json` vs `next.config.js` vs middleware)
- For new workflows: check existing workflow triggers — will this conflict with or duplicate an existing cron?

Add any conflicts found to the context block as **"Known conflicts"** so reviewers can evaluate them. If a conflict means the plan should be changed, change it BEFORE sending to reviewers.

### Phase 2: Six independent critiques (run ALL in parallel)

Launch ALL SIX simultaneously in a single message with parallel tool calls — the pre-mortem and the design reviewer run in parallel too, not after. Do not serialize them; latency matters and they're independent.

1. **Codex (GPT-5.x with codebase access) — Production & Architecture focus** — Run via Bash.
   **Codex check:** Run `command -v codex >/dev/null && echo READY || echo MISSING` first.
   - READY (local): **Step 1 — run Codex, writing its filtered output to a private per-run temp file:**
     ```bash
     set -o pipefail
     [ -s "${PLAN_FILE:-/tmp/critique-plan.txt}" ] || { echo "ERROR: plan file is missing or empty — write the plan file before running this reviewer"; exit 1; }
     # No suffix after the X's — see the mktemp note in Phase 1 (task #1081 finding).
     export PLAN_REVIEW_CODEX_OUT=$(mktemp /tmp/plan-review-codex-output.XXXXXX)
     {
     cat <<'PROMPT_HEAD'
   You are a production engineer and staff architect rolled into one. You have been on-call for 10 years AND you are known for finding simpler solutions. Your job is to find what will BREAK and what is UNNECESSARY.

   You can READ this repository — use Read/Grep on the actual files the plan touches. Generic advice is failure; every finding must cite a specific file:line or pattern from the codebase.

   Do NOT run `npm run data:check`, `npm install`, `setup-local-data.sh`, or any other setup/preflight command — this is a pure read-only critique of the plan below, no show/review data is needed, and worktree sessions do not have the full local data clone available. If CLAUDE.md's session-start convention would normally tell you to run a data-check preflight, that convention does not apply here: read the plan and the repository files directly and critique them.

   **PRODUCTION LENS** — Find what will fail:
   1. What will fail in production? (deployments, data corruption, partial failures, rollback gaps)
   2. Security vulnerabilities (injection, leaked secrets, unsanitized input)
   3. Missing error handling that will cause silent data loss
   4. Third-party dependencies that could change or break

   **ARCHITECTURE LENS** — Find what is over-engineered:
   5. Is any part of this plan more complex than it needs to be? What could be deleted entirely?
   6. Are there simpler alternatives to any component? (script instead of service, file instead of database, manual step instead of automation)
   7. Is the ordering wrong? Should any later step happen earlier, or vice versa?
   8. At scale, what breaks? (performance, data size, build times, API quotas)

   **EXECUTION LENS** — How will this actually run?
   9. CI vs local? If CI, is there a concrete reason it cannot run locally (faster, no push conflicts)? One-time backfills almost always belong local.
   10. Serial or parallel? If parallel, what shared state (files, databases, git branches) could conflict? Specifically: do multiple processes write to the SAME file? If so, this WILL corrupt data.
   11. What happens on push/merge conflict? Does the retry strategy (rebase, force-push, -X theirs) preserve data or silently discard the losing process's work?
   12. What is the failure mode — does partial failure leave data in a recoverable state, or does it require re-running everything from scratch?

   The context block at the top of the plan describes constraints that CANNOT be changed (tech stack, storage model, deployment target). Do not suggest switching these — focus on what will fail or is unnecessary WITHIN these constraints.

   **ERROR MAP** — For each new data flow or integration point, fill in: WHAT CAN GO WRONG → IS IT HANDLED? → WHAT DOES THE USER SEE? If the answer to 'is it handled' is 'no', that's a finding.

   Reference specific task IDs (e.g., S1-T3) and specific files (path:line). Under 600 words. Bullet points only.

   THE PLAN TO CRITIQUE:
   PROMPT_HEAD
     cat "${PLAN_FILE:-/tmp/critique-plan.txt}"
   } | codex exec --sandbox read-only --skip-git-repo-check --color never -C "$PWD" 2>&1 \
     | awk '/^codex$/{flag=1; next} /^tokens used$/{flag=0} flag' \
     | tee "$PLAN_REVIEW_CODEX_OUT"
     ```
     Note: uses your local Codex CLI (counts against ChatGPT Codex quota). Defaults to whatever model `~/.codex/config.toml` is set to.

     **Step 2 — validate the output before trusting it** (task #1081 — `codex exec` can exit 0 with zero bytes of output while the CLI reports READY; exit code and CLI presence do not prove the reviewer said anything. Task #1320 — a well-formed REFUSAL is long non-empty prose and must not be mistaken for a genuine zero-findings review). Run this immediately after Step 1, in the same shell so `$PLAN_REVIEW_CODEX_OUT` is still set:
     ```bash
     CODEX_CHECK=$(node -e "
       const { checkReviewOutput } = require('./scripts/lib/review-output-guard.js');
       const fs = require('fs');
       const text = fs.readFileSync(process.env.PLAN_REVIEW_CODEX_OUT, 'utf-8');
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
     rm -f "$PLAN_REVIEW_CODEX_OUT"
     ```
     If `CODEX_EMPTY` or `CODEX_REFUSED`: this is a coverage FAILURE, not a pass with nothing to say — do NOT report Codex as having run. Fall through to the exact same gpt-5.4-mini fallback used for MISSING below, and record in the coverage banner (Phase 3) that Codex was READY but returned unusable output — distinguish "empty" (CLI produced no text, task #1081) from "refused" (Codex explicitly declined, task #1320) using `$CODEX_REASON`, both distinct from "not installed".
   - MISSING (expected in cloud): do NOT fall straight to Claude — that removes the only GPT-family reviewer. Instead run this SAME prompt against **gpt-5.4-mini via `api.openai.com`** (`curl https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY"`, `model: "gpt-5.4-mini"`, this prompt as the message; check `jq -e '.error'` and surface any error). Only if `OPENAI_API_KEY` is also unavailable, use a Claude agent. Record which reviewer actually ran in the coverage banner (Phase 3).

2. **Independent Claude — Structure, Gaps & Devil's Advocate** — Use the Task tool with subagent_type "general-purpose" and this prompt:

   > You are two people: (1) a senior software engineer who is the most ruthless plan reviewer on the team, and (2) a devil's advocate who joined specifically to challenge assumptions. You have no context beyond what's written here — if something is unclear or assumed, call it out.
   >
   > **STRUCTURE & GAPS LENS:**
   > 1. Structural problems: Are the sprints in the right order? Does the dependency graph make sense? Are there circular dependencies?
   > 2. Missing work: What tasks are obviously needed but not listed? (migrations, config, cleanup, edge cases)
   > 3. Task atomicity: Are any tasks actually 2-3 tasks bundled together? Should any be split or merged?
   > 4. Acceptance criteria: Are any VERIFY statements untestable, ambiguous, or missing?
   > 5. Assumptions: What does this plan assume that might not be true?
   >
   > **DEVIL'S ADVOCATE LENS:**
   > 6. Developer experience: Will this be maintainable by someone unfamiliar with the codebase?
   > 7. Edge cases & real-world data: What inputs, formats, or data volumes will break this? What works in testing but fails with production data?
   > 8. Hidden coupling: What parts of this plan are secretly dependent on each other? What changes in one place will silently break another?
   > 9. What is NOT in this plan that should be? (rollback plan, monitoring, feature flags, data backfill)
   > 10. What is the single dumbest way this plan could fail that nobody has considered?
   > 10b. **Smallest viable first increment:** What is the SMALLEST first run that teaches the same lesson as the plan's first execution step? If the plan's first real run is N units (shows, files, records, users), could 1-2 units run mostly by hand first — before any batch tooling is built — and kill or validate the riskiest assumption for pennies? A plan whose first gate is "N units through new tooling" has usually skipped the "2 units by hand" step. Reviewers anchor on the plan's stated ramp; challenge the ramp itself. (Added 2026-08-09: six reviewers passed a backfill plan whose first gate was 5 shows through new tooling; the owner asked "wouldn't 2 shows by hand be wiser?" — it was.)
   >
   > **OPERATIONAL RISKS:**
   > 11. Are there shared resources (single JSON files, database rows, git branches) that parallel processes could corrupt? File-per-entity is safe; single-shared-file is not.
   > 12. Is the git push/merge strategy safe? (`git pull --rebase -X theirs` = silent data loss for the losing process. Plain `--rebase` on a shared file = conflict roulette.)
   > 13. Could any CI step run locally instead? Local is faster (no checkout/install overhead), has no push conflicts, and is easier to monitor. CI should be reserved for scheduled/recurring work, not one-time backfills.
   >
   > Find the NON-OBVIOUS problems. Do NOT give generic advice. Reference specific task IDs.
   > Under 700 words. Bullet points only.
   >
   > THE PLAN:
   > [paste the full plan text here]

3. **Pre-mortem analysis** — Use the Task tool with subagent_type "general-purpose" and this prompt:

   > You are conducting a pre-mortem analysis. Assume this plan was implemented exactly as written, deployed to production, and **failed catastrophically** 2 weeks later. You need to write the post-incident report.
   >
   > Structure your report with TWO scenarios:
   >
   > **PRIMARY SCENARIO** (~350 words) — the most likely catastrophic failure:
   >
   > **INCIDENT SUMMARY** (2 sentences — what happened and impact)
   >
   > **ROOT CAUSE** (the single most likely technical failure — be specific: which file, which data, which service)
   >
   > **CASCADE** (how the root cause led to broader failure — step by step)
   >
   > **WARNING SIGNS WE MISSED** (3-5 things that should have been caught in planning)
   >
   > **WHAT SHOULD HAVE BEEN DONE** (3-5 concrete preventive measures — not vague "add monitoring" but specific checks)
   >
   > **SECONDARY SCENARIO** (~150 words) — a different, independent failure mode:
   >
   > **WHAT HAPPENED** (2-3 sentences — different root cause than the primary)
   >
   > **PREVENTION** (1-2 concrete measures)
   >
   > The two scenarios MUST have different root causes. If the primary is about data/performance, the secondary should be about infrastructure/dependencies (or vice versa).
   >
   > Be creative and realistic. Think about: data growing larger than expected, parallel operations conflicting, third-party APIs changing formats, edge cases in real data that don't exist in test data, deployment platform limits.
   >
   > Pay SPECIAL attention to execution-level failures: parallel CI jobs writing to the same file and silently overwriting each other via rebase, git push retry strategies that discard data (`-X theirs`), operations that take 10x longer in CI than they would locally, and one-time tasks being over-engineered into CI workflows when a simple local script would work.
   >
   > Under 550 words total.
   >
   > THE PLAN:
   > [paste the full plan text here]

4. **Gemini — Consistency & Gap Checker** — Run this curl command via Bash.
   **Gemini check:** Run `echo ${GEMINI_API_KEY:+SET}` first. If empty, record Gemini as **MISSING** in the coverage banner (Phase 3) with the fix (set `GEMINI_API_KEY`; it rides the default `*.googleapis.com` allowlist, so no network change is needed) — don't just silently drop it. If SET, run the curl and check `jq -e '.error'`; surface any API error instead of emitting empty output.
   ```
   curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY" \
     -H "Content-Type: application/json" \
     -d "$(jq -n --arg plan "$(cat "${PLAN_FILE:-/tmp/critique-plan.txt}")" '{
       contents: [{parts: [{text: ("Review this plan for internal contradictions, gaps between stated goals and actual steps, and assumptions that are never validated.\n\n**CONSISTENCY LENS:**\n1. Does the plan contradict itself? (e.g., says \"simple\" but has 8 steps, says \"fast\" but requires 3 API calls)\n2. Are there gaps between what the plan SAYS it does and what the steps ACTUALLY do?\n3. What does the plan assume is true but never checks? (data exists, API is available, user has permissions)\n\n**GAP LENS:**\n4. What is the plan silent about? (error handling, rollback, what happens if step 3 fails)\n5. Are there steps that depend on each other but don't say so?\n6. What would a new developer ask after reading this plan that isn't answered?\n\nBe specific. Reference step numbers. Under 400 words. Bullet points only.\n\n" + $plan)}]}
     }')" | jq -r '.candidates[0].content.parts[0].text'
   ```

5. **User Impact & Platform Defaults** — Use the Task tool with subagent_type "general-purpose" and this prompt:

   > You are a reviewer whose sole job is to find ways this plan harms or confuses real end users — not developers, not systems, but the actual humans on the receiving end.
   >
   > First, identify who the real end users are in this plan (e.g. newsletter subscribers, API consumers, site visitors). There may be more than one type — name all of them before answering anything else.
   >
   > **USER IMPACT LENS:**
   > 1. Walk through the plan step by step. At what exact step does each user type's experience change? What do they experience before that step? What do they experience after? If there is a broken or confusing intermediate state, describe it specifically.
   > 2. What does any new third-party platform or service do BY DEFAULT that the plan doesn't explicitly disable or configure? (confirmation emails, welcome emails, sender names, notification flows, opt-in settings). If you lack reliable, specific knowledge of this platform's defaults, say so explicitly rather than guessing.
   > 3. What account-level or platform-level settings might silently override what the code does? (e.g., account-level double opt-in overriding an API `double_opt_in: false` flag). Flag your confidence level if relying on training-data knowledge of a specific platform.
   > 4. If this plan touches any communication channel (email, SMS, push notification), what is the first thing a real recipient sees — sender name, subject line, content? Is it correct and recognisable to them?
   >
   > **PLATFORM DEFAULTS LENS:**
   > 5. For any new platform being integrated: list the defaults for a brand-new account that are relevant to this plan. If you are not confident in specific defaults, say so and recommend manual verification steps instead.
   > 6. What does the plan assume about platform behaviour that should be explicitly verified in the UI before running any code against real users?
   >
   > Do NOT evaluate code correctness — other reviewers do that. Focus ONLY on what real users experience and what platform defaults could silently cause harm.
   > Under 400 words. Bullet points only.
   >
   > THE PLAN:
   > [paste the full plan text here]

6. **Code Design & Maintainability — Codebase-Grounded** — Use the Task tool with subagent_type "general-purpose" and this prompt. **This reviewer exists because the others check "will it work" but not "is it the right shape." Skipping it is the failure mode this skill was burned by — sessions shipped working code that turned into tech debt within weeks.**

   > You are a staff engineer whose ONLY job is to find DESIGN problems — not bugs, not gaps, not "will it compile." You evaluate whether the planned code is the RIGHT SHAPE for this codebase and whether it will age well. If your review only flags correctness issues, you have failed — the other reviewers cover that. Your job is the question they don't ask: "is this well designed?"
   >
   > **MANDATORY READING — do this first or your review is worthless:**
   > 1. Read every file the plan modifies or creates (current state if it exists; the directory siblings if it's a new file).
   > 2. Read 2–3 SIMILAR features in this codebase — features that solve adjacent problems — so you understand the established patterns. Use Glob/Grep to find them. List the files you read at the top of your review.
   > 3. Grep for the names of any new helpers/types/functions/components the plan introduces. If something with a similar name or purpose already exists, the plan may be reinventing it.
   >
   > Do NOT proceed to the design lens until you have read real code. Hand-waving from the plan text alone is not allowed.
   >
   > **DESIGN QUALITY LENS — find these specific problems:**
   >
   > 1. **Codebase fit / inconsistency tax.** Does the plan match how SIMILAR features are built in this codebase, or is it inventing its own pattern? Quote the existing pattern (file:line) and the diverging plan side by side. Inconsistency is a permanent tax on every future change — two ways of doing the same thing means future maintainers must learn both.
   >
   > 2. **Wrong abstraction.** Is the plan introducing a new abstraction (class, helper, module, type, hook) where an existing one fits? Is the abstraction at the right level — too premature (only 1 caller, speculative generality), too leaky (exposes internals callers shouldn't see), too generic (solves a problem we don't have)? Premature abstractions are as bad as missing ones.
   >
   > 3. **Reinventing existing primitives.** Search for existing helpers, modules, components, or utilities that already solve part of this problem. The plan is wrong if it does manually what an existing utility does, or rebuilds a helper that lives 2 directories over. Name the existing utility and the plan's reinvention side by side.
   >
   > 4. **Wrong layer / wrong responsibility.** Is logic going in a place that owns it? Validation in the view, business logic in the controller, scoring rules in a presentation component, side effects in pure functions, data shaping in route handlers, hardcoded brand colors in components — these are all design smells. Where SHOULD this code live, and why is the plan putting it elsewhere?
   >
   > 5. **Coupling and deletion cost.** If we wanted to DELETE this feature in 6 months, how many files would we have to touch? More than 5 = hidden coupling. Specifically: does the plan add this feature's name into shared registries, type unions, switch statements, barrel exports, or config files that will leak the abstraction across the codebase?
   >
   > 6. **Lifecycle / aging.** Will this design hold up if (a) the data 10x's, (b) a similar feature is added next quarter, (c) the underlying API changes its shape, (d) the surrounding code is refactored? Where will the breakage happen? Be specific about which file and which assumption.
   >
   > 7. **API surface design.** For any new public function/component/type the plan creates: is the parameter list minimal? Is it composable with existing primitives? Could two parameters be one? Could a flag be inferred from context? Is it pit-of-success (hard to misuse) or pit-of-failure (easy to call wrong)?
   >
   > 8. **Naming.** Are the new names (functions, files, types, components) accurate? Will someone reading the call site in 6 months understand what they do without opening the implementation? Misleading names are a permanent tax. Quote any name you'd change and what you'd change it to.
   >
   > 9. **Test surface.** Is the design easy to test, or does it require mocks/scaffolding/global state to exercise? Hard-to-test designs are usually badly factored — the test pain is the design telling you something.
   >
   > 10. **The "delete and rewrite" test.** If a future engineer wanted to rewrite this feature from scratch, would the plan's design make that easy or impossible? Designs that lock in their own assumptions or scatter themselves across the codebase are tech debt by construction.
   >
   > **OUTPUT FORMAT:**
   >
   > **FILES READ:** [list — including the similar files you used to learn the patterns, NOT just files the plan touches]
   >
   > **EXISTING PATTERNS YOU FOUND:** [2–3 references to similar code in this codebase that the plan should match — be specific about file:line and what the pattern is]
   >
   > **DESIGN PROBLEMS** (severity P0/P1/P2):
   > - [P0/P1/P2] [specific issue, with file:line and the existing-pattern alternative the plan should follow]
   >
   > **REDESIGN SUGGESTIONS** (concrete alternatives, not vague advice):
   > - [what to do instead, with why and a reference to the existing-pattern that supports it]
   >
   > **VERDICT:** Pick ONE — "Design is sound" / "N redesigns recommended (P1 or below)" / "Plan needs to be redrawn (P0 design issues)"
   >
   > Do NOT critique correctness, gaps, or user-facing concerns — the other 5 reviewers cover those. Focus ONLY on whether this is the right SHAPE of code for this codebase. Vague advice ("consider maintainability", "watch coupling") is not allowed — every finding must reference a specific file or pattern.
   >
   > Under 800 words.
   >
   > THE PLAN:
   > [paste the full plan text here]

### Phase 3: Present results

**Reviewer coverage (print this FIRST):** State which reviewers ran and on which model — specifically whether the Codex lens ran on Codex / GPT-4o / Claude, and whether Gemini ran. If any external-model reviewer fell back off its intended model, print a `⚠️` line naming it + the one-line fix. If the Codex lens hit `CODEX_EMPTY` (Codex CLI present, exited 0, but produced no usable text — task #1081) or `CODEX_REFUSED` (Codex explicitly declined to review — task #1320), say so explicitly, e.g. `⚠️ Codex ran but returned empty output (CLI flake, not missing) — fell back to gpt-5.4-mini` or `⚠️ Codex refused to review — fell back to gpt-5.4-mini`; don't fold either into a bare "reviewed" line, since an empty/refused-but-"passing" Codex run and a real zero-findings run must never look identical. A plan reviewed with fewer independent model families is weaker — say so explicitly rather than presenting it as full six-reviewer coverage.

Show all six critiques clearly with headers:
- **Codex (Production & Architecture)**
- **Claude (Structure & Devil's Advocate)**
- **Pre-Mortem (Failure Scenario)**
- **Gemini (Consistency & Gaps)**
- **User Impact & Platform Defaults**
- **Code Design & Maintainability** ← the one that catches "works but bad design"

### Phase 4: Synthesize and revise

After presenting all critiques:

1. **Consensus table** — Create a table of issues raised by 2+ reviewers, with columns: Issue | Raised by | Severity (P0/P1/P2) | Affected tasks. **Weight by expertise:**
   - Cross-family agreement (Codex + a Claude reviewer) on the same finding is high signal — different model lineages reaching the same conclusion despite both reading the codebase. Note: Gemini does NOT have codebase access; weight its findings on assumptions/contradictions, not code-level claims.
   - **Design Reviewer findings carry FULL weight even when raised alone.** This reviewer is the only one that read the existing codebase patterns — its findings about wrong abstraction, codebase fit, and deletion cost almost never show up in the other reviewers' output. A solo design finding is NOT a low-confidence finding; it's a high-signal finding from the only reviewer qualified to make it. Promote any design P0 to a blocker even if no other reviewer mentions it.
   - Any finding from the User Impact reviewer where real users would receive unexpected communication, be locked out, or experience irreversible harm is automatically P0. Cosmetic defaults and suboptimal experiences are P1.
   - Note the confidence level.

1.5. **Restructure-the-ramp escalation (MANDATORY check — do not skip).** Scan every reviewer's output, including solo findings, for language suggesting the plan's SCOPE or SEQUENCING should shrink or change order — not just gain another guard. Signal phrases: "isolate the riskiest piece and verify alone," "should be tested standalone before combining," "this could be validated smaller/cheaper/faster first," "de-risk before building tooling," "prove this works before automating it." (Task #1218: a structure reviewer said exactly this about the highest-risk step and it got folded into a gate-criteria bullet in the revised plan instead of restructuring the ramp — the fix that actually mattered, "2 shows by hand first," only surfaced when the owner asked for it directly.)
   - If found, do NOT fold it into the consensus table as one more P1/P2 row. Pull it out as its own labeled section — **"Restructure question"** — and explicitly ask in Phase 6/7: "should the plan's first increment be smaller, given this finding?" The user answers that question before the revised plan is finalized, not after.
   - This is a distinct check from Phase 0 — Phase 0 catches framing problems visible before the six reviewers run; this catches framing problems a reviewer surfaced but that synthesis would otherwise quietly absorb into "add a gate/guard" language.
   - **Stamp the outcome on the plan-verdict record (BWSC repo).** When this check fires (Phase 0 or here), the `record-plan` call at the end of this skill (below) must carry `--note="restructure-flag: adopted — <what shrank>"` if the user's answer changed the plan's scope/ramp, or `--note="restructure-flag: dismissed — <why the original scope stood>"` if they kept it as-is. Either way the note starts with `restructure-flag:` — that prefix is what `scripts/lib/infra-review-digest.js` counts to make this escalation's actual hit rate visible in the daily digest instead of disappearing the moment the session ends. A fired-but-unstamped escalation is invisible to every future audit of this skill.

2. **Sharpest unique insights** — List 2-3 concerns raised by only one reviewer that are too good to ignore. Explain why they matter.

3. **Changes table** — Create a table: Change | Reason | Source (which reviewer). This tracks exactly what changed and why.

4. **Revised plan** — Write a concrete, improved version addressing all P0 and P1 issues. Mark changes with `[CHANGED: reason — source]` annotations inline. Don't just list fixes — rewrite the actual plan.

5. **Model recommendation** — For the revised plan, note which Claude model suits the implementation: **Opus** for complex/architectural work, **Sonnet** for well-defined straightforward tasks (config, data fixes, routine CRUD). If the plan has distinct phases, recommend per-phase.

### Phase 5: Quick validation of the revised plan

After writing the revised plan, do a fast self-check (do NOT run the full critique again):
- Did any change introduce a new dependency that breaks the ordering?
- Did any change make a task no longer atomic?
- Does the critical path still make sense?
- Are the VERIFY statements still concrete and testable?
- Did the revised plan introduce NEW tasks/phases that themselves could fail? (e.g., a new "build simulation" phase is itself new work that needs testing — don't create untested additions while fixing tested ones)
- **Effort re-estimate:** If the revised plan added phases, expanded tasks, or introduced new validation gates, include a revised effort estimate compared to the original. The user needs to decide if the added rigor is worth the added time.

If issues are found, fix them and note what was fixed.

### Phase 6: Plain-language summary

Before asking the user to decide, present **the actual plan in plain English** — not just what changed, but what they're agreeing to:

> **The plan:**
> [2-4 sentences: what will be built, how it works from the user's perspective, what the end result looks like]
>
> **What the reviewers changed:**
> - [change 1 and why]
> - [change 2 and why]
>
> **Size:** [S/M/L — how many sessions, roughly how many files]

The user is approving THE PLAN, not a diff. They need to see the plan. No jargon, no task IDs. Describe it the way you'd explain it to someone who hasn't been in this conversation.

**Sprint-plan recommendation:** Based on the revised plan's scope, recommend whether `/plan-tasks` is needed:
- **1 session / <5 files:** "This is small enough to implement directly from this plan. No need for `/plan-tasks`."
- **2-4 sessions:** "Recommend running `/plan-tasks` to break this into atomic tasks with verify steps."
- **5+ sessions / multiple workstreams:** "`/plan-tasks` is essential here — task ordering and parallelism matter."

### Phase 7: Ask the user

Present the revised plan and ask: "Want to go with the revised plan, keep the original, or adjust further?"

### Record the plan-phase verdict (BWSC repo — MANDATORY)

As soon as the critique is complete — before the user answers Phase 7, and whether or not the plan changes — record it:

```bash
node scripts/lib/review-gate.mjs --query=record-plan --reviewer=plan-review \
  --result=pass --session-id="$CLAUDE_CODE_SESSION_ID" --note="<one line: what the review changed>"
```

`~/.claude/hooks/infra-plan-review-gate.sh` reads this before the session's first edit to shared infrastructure — the dispatch layer, spend guards, concurrency primitives, the review gates, CI workflows and hooks (task #1079, owner decision 2026-08-05, scope in `scripts/lib/infra-review-scope.js`). Without the record the session stays blocked no matter how thorough the review was.

Use `--result=fail` when the reviewers found P0 blockers the plan does not resolve. A fail verdict does not unblock; overturning it is the owner's call, recorded as `--reviewer=owner-override`.

### Notion Update (BWSC projects only)

After the user approves a plan, update the session's Notion card:
1. Append to Outcome: `### Plan approved\n[1-line summary of approach, scope (S/M/L), key changes from review]`
2. If the plan was rejected or needs major rework, note that too — it's a decision worth recording.
