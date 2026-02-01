Break a project down into sprints and atomic tasks. Run autonomously — do not ask for user approval unless truly critical (ambiguous requirements that would waste significant work if guessed wrong).

## Instructions

### Phase 1: Understand the project

Identify the project to plan. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent project description, feature request, or goal in the conversation

If working in a codebase, use the Explore agent (Task tool, subagent_type "Explore") to understand the existing architecture, patterns, and conventions before planning. This is NOT optional — plans without codebase context produce generic tasks that miss existing infrastructure.

Specifically find out:
- What already exists that can be reused (scripts, schemas, components, workflows)
- Tech stack details (framework, deployment target, data storage)
- Known constraints (bundle size limits, API quotas, rate limits, deployment platform limits)
- Existing automation (CI/CD, GitHub Actions, scheduled jobs)

### Phase 2: Sprint decomposition

Break the project into sprints. For each sprint, follow these rules:

**Sprint-level rules:**
- Each sprint MUST result in demoable, runnable software that builds on previous sprints
- Every sprint has a one-sentence **Sprint Goal** (what can be demoed at the end)
- Every sprint has a **Risk Flag** section listing what could go wrong
- Sprint 1 always starts with foundational work (infrastructure, data architecture, validation) AND ends with something visible working
- The final sprint includes cleanup, documentation, and hardening
- **Manual before automated:** If the plan involves building automation for a process, do the process manually first (at least 2-3 times) to discover edge cases, THEN automate. Never automate a process you haven't run manually.

**Task-level rules:**
- Every task is an atomic, committable piece of work (one commit, one concern)
- Every task has a **Complexity** rating: S (< 30 min), M (30-90 min), L (90+ min). If L, break it down further
- Every task lists **Files touched** (new or modified — use actual paths if in an existing codebase)
- Every task has **Acceptance criteria** in this format:
  ```
  VERIFY: [concrete check — a command to run, a thing to see, a test that passes]
  ```
  Examples:
  - `VERIFY: npm test -- --grep "auth" passes with 0 failures`
  - `VERIFY: Homepage loads at localhost:3000 and displays the header`
  - `VERIFY: curl /api/users returns 200 with JSON array`
  - `VERIFY: git diff shows only the expected file changes`
- Every task has **Depends on** listing task IDs it's blocked by (or "None")
- Every task has **Parallel** flag: Yes/No — can this be worked on simultaneously with other tasks in the sprint?

**Task format:**
```
### Task S1-T1: [Imperative title — e.g., "Create user model with validation"]
- **Complexity:** S / M / L
- **Depends on:** None / S1-T1, S1-T2
- **Parallel:** Yes / No
- **Files:** src/models/user.ts (new), src/models/index.ts (modify)
- **Description:** [2-3 sentences max — what and why, not how]
- **Acceptance criteria:**
  - VERIFY: [concrete check]
  - VERIFY: [concrete check]
```

### Phase 2b: Identify parallel workstreams

After decomposing into sprints, analyze the dependency graph across the entire plan and identify **parallel workstreams** — groups of sprints or tasks that have no dependencies on each other and can be executed simultaneously by different agents or people.

**Rules:**
- A workstream is a sequence of tasks/sprints that share a dependency chain but are independent of other workstreams
- Common patterns: frontend vs backend, different feature areas, infrastructure vs application logic, data pipeline vs UI
- Two sprints can run in parallel if neither contains tasks that depend on the other's outputs
- Even within a sequential plan, there are often 2-3 tasks per sprint that form independent tracks

**Output a parallel execution map** like:
```
Agent/Track 1:  S1-T1 → S1-T3 → S2-T1 → S2-T4
Agent/Track 2:  S1-T2 → S1-T4 → S2-T2 → S2-T3
Agent/Track 3:            S1-T5 → S2-T5 → S3-T1
Sync points:    ──────── after S1 ──────── after S2 ────
```

Sync points are where tracks must merge before continuing (e.g., frontend needs the API to exist before integration).

**If the project is large enough**, restructure the plan so parallel workstreams are explicit — instead of just Sprint 1, 2, 3 in sequence, show which sprints can overlap:
```
Phase A: Sprint 1 (setup) — all tracks
Phase B: Sprint 2 (backend) ║ Sprint 3 (frontend) — parallel
Phase C: Sprint 4 (integration) — all tracks merge
```

### Phase 3: Self-validation checklist

Before proceeding to critique, go through EACH of these checks and explicitly state pass/fail. Do not skip this — write the results out:

1. **Completeness:** Walk through the sprints in order. Can sprint 1 actually be demoed? Does sprint 2 build on sprint 1? Any gaps? **PASS/FAIL:**
2. **Atomicity:** Is every task truly one commit? If a task says "and" in the title, split it. **PASS/FAIL:**
3. **Dependency chain:** Are there circular dependencies? Are dependencies realistic? **PASS/FAIL:**
4. **Test coverage:** Does every task have a concrete VERIFY that a human or CI could run with a yes/no result? **PASS/FAIL:**
5. **Missing work:** Did you forget migrations, config, environment setup, error handling, edge cases, validation, rollback strategy? **PASS/FAIL:**
6. **Ordering:** Could tasks be reordered for faster progress? Are parallelizable tasks marked? **PASS/FAIL:**
7. **Parallel workstreams:** Have you maximized parallelism? Are there tasks marked sequential that could actually run in parallel? Could entire sprints overlap? **PASS/FAIL:**
8. **Manual before automated:** If the plan automates something, is there a manual run first? **PASS/FAIL:**
9. **Scale check:** If the plan involves data growth, have you validated that the system handles 10x the current data? **PASS/FAIL:**

Fix any FAIL items before proceeding.

### Phase 4: Critique the plan

Use `/critique` to run the full multi-model critique (GPT-4o + Gemini + Claude agent + pre-mortem) on your sprint plan. This gives you 4 independent perspectives with differentiated focus areas.

If `/critique` is not available, use the Task tool with subagent_type "general-purpose" to run an independent review:

> You are a senior engineering manager reviewing a sprint plan. Check for:
> 1. Tasks that are too large or vague
> 2. Missing dependencies or wrong ordering
> 3. Sprints that wouldn't actually be demoable
> 4. Missing edge cases, error handling, or infrastructure work
> 5. Acceptance criteria that are ambiguous or untestable
> 6. Over-engineering or unnecessary tasks
> 7. Ordering problems — should anything later happen earlier?
> 8. If the plan has 3 AI agents, how would you restructure for maximum parallelism?
>
> Be specific. For each issue, say which task ID and what to fix.

Address the critique feedback. If the critique requires major restructuring (sprint reordering, new tasks, deleted tasks), rewrite the plan rather than patching it.

### Phase 5: Write the output

Write the final sprint plan to a markdown file. Use `sprint-plan.md` in the current project root, or a more specific name if appropriate (e.g., `sprint-plan-auth-system.md`).

The file should have this structure:

```markdown
# Sprint Plan: [Project Name]

## Overview
[2-3 sentence summary of what we're building]

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 1      | ...  | 5     | 3S, 2M     |
| 2      | ...  | 4     | 1S, 2M, 1L |

## Sprint 1: [Sprint Goal]
**Demo:** [What can be shown at the end of this sprint]
**Risks:** [What could go wrong]

### Task S1-T1: ...
[full task details]

---

[... all sprints ...]

---

## Dependencies Graph
[Show which tasks block which — use text like "S1-T1 → S1-T3 → S2-T1"]

## Parallel Execution Map
[Show how work can be split across multiple agents/people]

Track 1:  S1-T1 → S1-T3 → S2-T1 → ...
Track 2:  S1-T2 → S1-T4 → S2-T2 → ...
Sync:     ──── after S1 ──── after S2 ────

**Parallel sprints:** [List any sprints that can run simultaneously]
**Critical path:** [The longest sequential chain that determines minimum total effort]
**Max parallelism:** [How many agents/people could work simultaneously at peak]

## Known Edge Cases
[Document edge cases discovered during planning — things that need special handling, unusual data, platform-specific gotchas. This is a living document that should be updated during implementation.]

## Changes from Critique
| Change | Reason | Source |
|--------|--------|--------|
| [what changed] | [why] | [which reviewer flagged it] |

## Key Risks
[Top 3 project-level risks and mitigations]

Use subagents liberally! For all parts.
```

Tell the user the file has been written and give a brief summary (sprint count, total tasks, key risks).
