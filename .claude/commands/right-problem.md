Most wasted work starts with the wrong question. Two models debate whether you're solving the right problem.

## When to use

Run `/right-problem` BEFORE writing a detailed plan or using `/plan-review`. The workflow is:
1. Idea → `/right-problem` → Validated approach
2. Validated approach → Plan → `/plan-review` → Refined plan → Implement

`/plan-review` finds implementation bugs. `/right-problem` finds wrong-approach bugs. Both are needed for high-stakes work.

**Mandatory for any feature estimated at >1 day of work.** See CLAUDE.md §10.

## Instructions

### Phase 1: Extract and reframe the problem

Identify the idea or problem to evaluate. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent idea, feature request, or proposed change in the conversation

**Critical reframing step — do NOT skip:**

Restate the problem by separating:
- **The literal request** (what the user/developer asked for, verbatim)
- **The underlying need** (what they're actually trying to achieve — this is often different from the literal request)
- **Current direction** (if a solution has already been proposed or is being discussed, state it explicitly — reviewers need to evaluate whether the current path is wrong, not just optimize it)
- **Current state** (what exists today that's relevant — data, features, infrastructure)
- **Constraints** (time, budget, technical limitations, user context)

If working in a codebase, use Glob/Grep/Read to understand what data and tools already exist that could potentially solve this without new work. This is NOT optional — the #1 failure mode this skill prevents is "building something new when existing infrastructure already solves the problem."

**Generate unique temp files for this run (prevents cross-contamination in parallel sessions):**
```bash
PROB_FILE=$(mktemp /tmp/gut-check-problem-XXXXXX.txt)
PROB_ONLY_FILE=$(mktemp /tmp/gut-check-problem-only-XXXXXX.txt)
echo "Problem files: $PROB_FILE  $PROB_ONLY_FILE"
```
Use `$PROB_FILE` and `$PROB_ONLY_FILE` throughout all subsequent phases.

**Already-built short-circuit:** If the codebase check finds the feature/solution is ALREADY FULLY IMPLEMENTED, write `⚠️ ALREADY BUILT: [what exists and where]` prominently in `$PROB_FILE`, then **skip Phases 2-3 entirely** and jump to Phase 5. Report: what exists, what files contain it, whether it's working or broken, and what the right action is (verify it works / fix it / enable it). Do not generate approaches for something that's already done.

Write this analysis to `$PROB_FILE`.

### Phase 2: Generate three approaches (simplest to most complex)

Generate three approaches yourself. **Acknowledge that these are biased** — you are anchored on the current direction. The gpt-5.4-mini reviewer in Phase 3 will generate fresh alternatives independently to counteract this bias.

**Approach A (Simplest possible — "Do Nothing" is valid):** First, explicitly ask: "What breaks if we do nothing?" If the answer is "nothing breaks, it's just not ideal" — then "Do Nothing" or "Do Nothing + a label/disclaimer" IS Approach A. Otherwise, what's the dumbest thing that could work? Can we solve this with data/tools we already have? A config change? Adding a field? A manual process? Think: minutes to hours of work.

**Approach B (Targeted solution):** A focused technical solution. New code, but minimal scope. Think: hours to a day of work.

**Approach C (Full-featured):** The comprehensive engineering solution. New systems, pipelines, or infrastructure. Think: multiple days of work.

**Anti-anchoring check:** If a solution was already proposed, you are likely anchored on it. Deliberately make Approach A as strong as possible. Ask yourself: "If I were starting from scratch with no existing proposal, would I really build what's being proposed?"

For each approach, write:
- What it involves (2-3 sentences)
- What it gets right
- What it doesn't cover
- **Cost of inaction** (what breaks or degrades if we DON'T do this approach?)
- Rough effort (hours, not days — Claude Code moves fast)

If the "current direction" doesn't match any of the three approaches, include it as a labeled fourth option.

Append these approaches to `/tmp/gut-check-problem.txt`.

**Also write a problem-only version** (WITHOUT the approaches) to `/tmp/gut-check-problem-only.txt` — this is what gpt-5.4-mini gets, so it generates alternatives from scratch without being anchored.

### Phase 3: Two reviewers with DIFFERENT jobs (run BOTH in parallel)

The reviewers have sharply different roles. gpt-5.4-mini challenges and generates alternatives. Claude evaluates and judges. They do NOT do the same thing.

1. **gpt-5.4-mini — Challenger & Alternative Generator** — Run this curl command via Bash.
   **OpenAI check:** Run `echo ${OPENAI_API_KEY:+SET}` first. If empty, skip the curl and use a Claude agent (Task tool, subagent_type "general-purpose") with the same prompt below. Note: "gpt-5.4-mini unavailable — using Claude as second reviewer."
   **IMPORTANT: gpt-5.4-mini gets `/tmp/gut-check-problem-only.txt` (problem only, NO approaches).** This forces it to generate fresh alternatives without anchoring.
   ```
   curl -s https://api.openai.com/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $OPENAI_API_KEY" \
     -d "$(jq -n --arg problem "$(cat "${PROB_ONLY_FILE:-/tmp/gut-check-problem-only.txt}")" '{
       model: "gpt-5.4-mini",
       temperature: 0.5,
       messages: [
         {role: "system", content: "You are a contrarian product thinker who has killed more features than you have shipped. Your ONLY job is to generate alternatives that nobody has considered and to argue AGAINST the obvious solution. You are not here to validate — you are here to challenge. If your review agrees with the current direction, you have FAILED at your job.\n\nYou will receive a problem description and current direction. You will NOT receive proposed approaches. This is intentional — you must think from scratch.\n\n**YOUR TASKS:**\n\n1. **Name 3 specific users** who might encounter this feature. Not generic personas — specific people with a specific scenario. E.g., \"a tourist who just saw Hamilton and googles the lead actor\" or \"a theater critic researching a venue for an article.\" For EACH user, answer: would they actually notice or care about this feature? Be brutally honest.\n\n2. **Generate 2-3 alternative approaches from scratch.** At least one must be radically simpler than whatever is being proposed (a UX change, an external link, a label change, doing nothing). At least one must be something nobody would think of on first pass. Do NOT just generate variations of the current direction. Think laterally.\n\n3. **What breaks if we do NOTHING?** Be specific. If the answer is \"nothing breaks, it just isn't ideal\" — say so clearly. This is the most important question.\n\n4. **Name the single biggest risk** of the current direction. Not a list of concerns — the ONE thing most likely to make this a waste of time. Be specific (which component, which data, which user scenario).\n\n5. **Rough cost/benefit for each alternative you propose:** X hours to build → Y users benefit → is it worth it?\n\n**CRITICAL CONSTRAINT: This is a solo developer project. Typical session: 1-2 hours, single developer, under 1000 lines of code. Alternatives that require 10+ hours, a team, or new infrastructure are not useful.** Generate alternatives that fit within the actual project constraints.\n\nIf you find yourself agreeing that the obvious solution is fine, you are not trying hard enough. Push harder. Find the non-obvious path.\n\nUnder 500 words. Bullet points only."},
         {role: "user", content: ("Challenge this idea. Generate alternatives nobody has considered. Argue against the obvious path.\n\n" + $problem)}
       ]
     }')" | jq -r '.choices[0].message.content'
   ```

2. **Independent Claude — Judge & Evaluator** — Use the Task tool with subagent_type "general-purpose" and this prompt.
   **IMPORTANT: Claude gets `/tmp/gut-check-problem.txt` (problem WITH approaches).** It evaluates the approaches that were generated.

   > You are the final judge on whether this idea is worth building and which approach is correct. You've killed 30+ features that shouldn't have been built. You are rigorous, quantitative, and user-obsessed.
   >
   > You will receive a problem description AND proposed approaches. Evaluate them:
   >
   > **USER REALITY CHECK:**
   > 1. Name 3 specific user types (e.g., "a fan who just saw a show and wants to explore the cast," "a student researching Broadway history"). For EACH user type: would they notice this feature? Would they care? How often would they use it?
   > 2. Walk through the actual user journey for each approach — what do they see, tap, experience on their phone?
   >
   > **COST/BENEFIT QUANTIFICATION:**
   > 3. For each approach, estimate: hours to build → number of users who benefit → frequency of benefit. Is the ROI justified? Be specific — "5 hours to build for a feature 2% of users will see once" is a clear no.
   > 4. What is the opportunity cost? What ELSE could be built with this time that would benefit MORE users?
   >
   > **COST OF INACTION:**
   > 5. What happens if we build NOTHING? Does something break? Does a metric decline? Or is it just "not ideal"? Be honest — "nothing breaks" is a valid and important answer.
   >
   > **APPROACH EVALUATION:**
   > 6. Is the problem statement itself correct? Sometimes the real problem is different.
   > 7. Is there a 4th approach nobody listed? (UX solution, external link, label change, doing nothing)
   > 8. Does the simplest approach actually work? If yes, champion it aggressively. If not, explain the SPECIFIC scenario where it fails.
   >
   > End with a clear, opinionated recommendation. Under 500 words. Bullet points only.
   >
   > THE PROBLEM AND APPROACHES:
   > [paste full text from /tmp/gut-check-problem.txt]

### Phase 4: Present results

Show both reviews clearly with headers:
- **gpt-5.4-mini (Challenger — fresh alternatives)**
- **Claude (Judge — approach evaluation)**

### Phase 5: Synthesize and recommend

After presenting both reviews:

1. **Fresh alternatives check** — Did gpt-5.4-mini generate an alternative that's better than any of the original 3 approaches? If yes, this is the highest-value output of the skill. Highlight it prominently. Compare it against Claude's recommendation.

2. **User reality check** — Do both reviewers agree on WHO benefits and HOW MUCH? If both say "2% of users, rarely" — the feature probably isn't worth building. If they disagree on user impact, investigate why.

3. **Cost/benefit summary** — Synthesize the ROI estimates from both reviewers into a clear table:
   | Approach | Hours to build | Users who benefit | Frequency | Worth it? |

4. **Cost of inaction** — Synthesize what both reviewers say about doing nothing. If both agree "nothing breaks," this is a strong signal the feature may not be worth building. If they disagree, investigate why.

5. **Red flags caught** — List any "wrong problem" or "wrong approach" issues:
   - "The literal request was X but the real need is Y"
   - "Existing data already solves this — no new code needed"
   - "This is a UX problem being treated as a data problem"
   - "gpt-5.4-mini's alternative X is better than all 3 original approaches"

6. **Direction change alert** — If the current direction should change, call this out prominently:
   - What was about to be built
   - Why it's the wrong approach
   - What should be built instead (or nothing)

7. **Final recommendation** — State ONE recommended approach with:
   - **What to build** (2-3 sentences, concrete)
   - **Why this approach** (referencing specific reviewer arguments)
   - **What it intentionally does NOT include** (and why that's OK for now)
   - **Upgrade trigger** (specific condition for when to reconsider)

### Phase 6: Ask the user

Present the recommendation and ask: "Does this approach make sense? Should I proceed to detailed planning with this approach, adjust it, or explore a different direction?"

If the user approves, recommend the next step based on project size:
- **1 session / <5 files:** Skip `/plan-tasks`. Run `/second-opinion` or `/plan-review` on the approach, then implement directly. Sprint planning adds documentation overhead without discovery value at this scale.
- **2-4 sessions:** `/plan-tasks` helps with task ordering and commit discipline. Recommended.
- **5+ sessions / multiple workstreams:** `/plan-tasks` is essential for parallelism and dependencies.

The validated approach should be referenced in the plan's introduction so `/plan-review` reviewers have context on why alternatives were rejected.
