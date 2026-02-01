Rigorously critique and improve an implementation plan using three independent AI models with differentiated roles, a pre-mortem analysis, and a concrete revised plan.

## Instructions

### Phase 1: Gather the plan and context

Identify the plan to critique. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent plan or proposed changes in the conversation

Write the plan text to a temporary file at `/tmp/critique-plan.txt`.

**Context enrichment:** If working in a codebase, add a brief context block at the top of the plan file describing:
- Tech stack (language, framework, deployment target)
- Data storage approach (database, files, etc.)
- Key constraints (bundle size limits, rate limits, API quotas, etc.)
- What already exists vs. what's new

This context prevents reviewers from giving generic advice that doesn't apply.

### Phase 2: Four independent critiques (run ALL in parallel)

Launch ALL FOUR of these simultaneously — the pre-mortem runs in parallel too, not after:

1. **GPT-4o — Production & Security focus** — Run this curl command via Bash:
   ```
   curl -s https://api.openai.com/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $OPENAI_API_KEY" \
     -d "$(jq -n --arg plan "$(cat /tmp/critique-plan.txt)" '{
       model: "gpt-4o",
       temperature: 0.3,
       messages: [
         {role: "system", content: "You are a production engineer who has been on-call for 10 years. You have seen every way a deployment can fail. Your job is to find what will BREAK, not what could be improved.\n\nFocus ONLY on:\n1. What will fail in production? (deployments, data corruption, partial failures, rollback gaps)\n2. Security vulnerabilities (injection, leaked secrets, unsanitized input from external sources)\n3. Missing error handling that will cause silent data loss\n4. Third-party dependencies that could change or break\n\nDo NOT give generic advice like \"add error handling\" or \"consider security\". Name the SPECIFIC task/step that will fail and HOW it will fail.\n\nReference specific task IDs (e.g., S1-T3) when possible. Under 400 words. Bullet points only."},
         {role: "user", content: ("Critique this plan — what will break in production?\n\n" + $plan)}
       ]
     }')" | jq -r '.choices[0].message.content'
   ```

2. **Gemini 2.0 Flash — Architecture & Alternatives focus** — Run this curl command via Bash:
   ```
   curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY" \
     -H "Content-Type: application/json" \
     -d "$(jq -n --arg plan "$(cat /tmp/critique-plan.txt)" '{
       systemInstruction: {parts: [{text: "You are a staff engineer known for finding simpler solutions. Your job is to challenge the architecture and find over-engineering.\n\nFocus ONLY on:\n1. Is any part of this plan more complex than it needs to be? What could be deleted?\n2. Are there simpler alternatives to any component? (e.g., a script instead of a service, a file instead of a database, a manual step instead of automation)\n3. Is the ordering wrong? Should any later step happen earlier, or vice versa?\n4. Are there missing dependencies or tasks that will be discovered mid-implementation?\n5. At scale, what breaks? (performance, data size, build times, API quotas)\n\nDo NOT repeat security or error handling concerns. Focus on architecture and simplification.\n\nReference specific task IDs when possible. Under 400 words. Bullet points only."}]},
       contents: [{role: "user", parts: [{text: ("Critique this plan — what is over-engineered or mis-ordered?\n\n" + $plan)}]}],
       generationConfig: {temperature: 0.3}
     }')" | jq -r '.candidates[0].content.parts[0].text'
   ```

3. **Independent Claude critique — Structure & Gaps focus** — Use the Task tool with subagent_type "general-purpose" and this prompt:

   > You are a senior software engineer reviewing an implementation plan you had no part in creating. You are the most ruthless reviewer on the team. You have no context beyond what's written here — if something is unclear or assumed, call it out.
   >
   > Focus ONLY on:
   > 1. Structural problems: Are the sprints in the right order? Does the dependency graph make sense? Are there circular dependencies?
   > 2. Missing work: What tasks are obviously needed but not listed? (migrations, config, cleanup, edge cases)
   > 3. Task atomicity: Are any tasks actually 2-3 tasks bundled together? Should any be split or merged?
   > 4. Acceptance criteria: Are any VERIFY statements untestable, ambiguous, or missing?
   > 5. Assumptions: What does this plan assume that might not be true?
   >
   > Do NOT give generic advice. Reference specific task IDs. Under 500 words. Bullet points.
   >
   > THE PLAN:
   > [paste the full plan text here]

4. **Pre-mortem analysis** — Use the Task tool with subagent_type "general-purpose" and this prompt:

   > You are conducting a pre-mortem analysis. Assume this plan was implemented exactly as written, deployed to production, and **failed catastrophically** 2 weeks later. You need to write the post-incident report.
   >
   > Structure your report as:
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
   > Be creative and realistic. Think about: data growing larger than expected, parallel operations conflicting, third-party APIs changing formats, edge cases in real data that don't exist in test data, deployment platform limits.
   >
   > Under 500 words.
   >
   > THE PLAN:
   > [paste the full plan text here]

### Phase 3: Present results

Show all four critiques clearly with headers:
- **GPT-4o (Production & Security)**
- **Gemini (Architecture & Alternatives)**
- **Claude (Structure & Gaps)**
- **Pre-Mortem (Failure Scenario)**

### Phase 4: Synthesize and revise

After presenting all critiques:

1. **Consensus table** — Create a table of issues raised by 2+ reviewers, with columns: Issue | Raised by | Severity (P0/P1/P2) | Affected tasks

2. **Sharpest unique insights** — List 2-3 concerns raised by only one reviewer that are too good to ignore. Explain why they matter.

3. **Changes table** — Create a table: Change | Reason | Source (which reviewer). This tracks exactly what changed and why.

4. **Revised plan** — Write a concrete, improved version addressing all P0 and P1 issues. Mark changes with `[CHANGED: reason — source]` annotations inline. Don't just list fixes — rewrite the actual plan.

### Phase 5: Quick validation of the revised plan

After writing the revised plan, do a fast self-check (do NOT run the full critique again):
- Did any change introduce a new dependency that breaks the ordering?
- Did any change make a task no longer atomic?
- Does the critical path still make sense?
- Are the VERIFY statements still concrete and testable?

If issues are found, fix them and note what was fixed.

### Phase 6: Ask the user

Present the revised plan and ask: "Want to go with the revised plan, keep the original, or adjust further?"
