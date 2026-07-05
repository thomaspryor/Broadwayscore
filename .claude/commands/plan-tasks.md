Turn a validated plan into atomic, committable tasks. Each one has a verify step so you know when it's done.

**AUTONOMY RULE:** Make decisions yourself and keep moving. If a choice is ambiguous, state your recommendation and proceed — the user will redirect if they disagree. Only stop to ask when guessing wrong would waste significant work (e.g., unclear requirements, conflicting constraints, "should this be a new feature or an extension of X?").

## Size check (do this FIRST)

Estimate the feature size before planning:
- **S (<8 tasks, ≤3 files, 1 session):** Use **lite mode** below. No sprints, no parallel maps, no self-validation checklist. Just a numbered task list with verify steps.
- **M (8-20 tasks, 4-10 files, 2-4 sessions):** Use full mode with sprints.
- **L (20+ tasks, 10+ files, 5+ sessions):** Use full mode with parallel workstreams.

### Lite mode (S features)

Skip directly to producing this format:
```
## Tasks

1. [Task title]
   Files: [paths]
   VERIFY: [concrete check]

2. [Task title]
   Files: [paths]
   VERIFY: [concrete check]
...
```

No sprint grouping, no parallel execution maps, no model recommendations, no 9-point self-validation. Just tasks with verify steps. Then proceed to `/execute-plan` or implement directly.

### Full mode (M/L features)

## Instructions

### Phase 1: Understand the project

Identify the project to plan. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent project description, feature request, or goal in the conversation

If working in a codebase, use the Explore agent (Task tool, subagent_type "Explore") to understand the existing architecture, patterns, and conventions before planning. This is NOT optional — plans without codebase context produce generic tasks that miss existing infrastructure.

**Roadmap context:** Read the current roadmap to check for related items, dependencies, or prior decisions:
```bash
gh issue view 1 --repo thomaspryor/broadway-scorecard-data --json body -q '.body' | head -100
```
Note any roadmap items that overlap with or depend on this work.

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
- Every task is an atomic, committable piece of work (one commit, one concern). **COMMIT IMMEDIATELY after each task passes its VERIFY check.** Do not accumulate uncommitted changes across tasks — context can expire at any time and uncommitted work WILL be lost.
- **Bite-sized granularity:** Each task should be completable in a few minutes. If a task has "and" in the title, split it. "Create model AND add validation AND write tests" = three tasks. The right size: one action, one verify, one commit.
- Every task has a **Complexity** rating: S (one file, clear spec) / M (2-4 files, some exploration) / L (5+ files or architectural risk). If L, break it down further — L tasks are a smell.
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
- **Complexity:** S (one file, clear spec) / M (2-4 files, some exploration) / L (5+ files or architectural risk)
- **Depends on:** None / S1-T1, S1-T2
- **Parallel:** Yes / No
- **Files:** src/models/user.ts (new), src/models/index.ts (modify)
- **Description:** [2-3 sentences max — what and why, not how]
- **Acceptance criteria:**
  - VERIFY: [concrete check]
  - VERIFY: [concrete check]
```

### Phase 2b: Identify parallel workstreams

After decomposing into sprints, analyze the dependency graph and identify **parallel workstreams** — groups of tasks that have no dependencies on each other.

> **⚠️ What "parallel" means here (read this before writing tracks):**
>
> "Parallel" in this plan means **subagent-parallelism within a single Claude session executing `/execute-plan`** — one coordinator agent dispatches multiple implementer subagents that work on independent files concurrently. The coordinator owns the worktree, the git history, the commits.
>
> **It does NOT mean "open multiple Claude Code sessions and split the tracks across them."** That model breaks in practice because each session creates its own worktree off main, both pull/push to the same remote, and the second session's `git pull --rebase` quietly clobbers the first session's uncommitted edits — or worse, both push and one overwrites the other. The user has been bitten by this. Multi-session "parallelism" is not supported by this skill.
>
> If the plan is genuinely too big for one session's context window, the right answer is **sequential sprints across multiple sessions**, not parallel sessions. Each session runs one sprint to completion, commits + pushes, then a fresh session picks up the next sprint with a clean main.

**Rules:**
- A workstream is a sequence of tasks that share a dependency chain but are independent of other workstreams within one session's run
- Common patterns: frontend vs backend, different feature areas, infrastructure vs application logic, data pipeline vs UI
- Two sprints can run in parallel (as subagent tracks within one session) only if neither contains tasks that depend on the other's outputs AND neither modifies the same file
- Even within a sequential plan, there are often 2-3 tasks per sprint that form independent subagent tracks

**Output a subagent execution map** like:
```
Subagent track 1:  S1-T1 → S1-T3 → S2-T1 → S2-T4
Subagent track 2:  S1-T2 → S1-T4 → S2-T2 → S2-T3
Subagent track 3:            S1-T5 → S2-T5 → S3-T1
Sync points:       ──────── after S1 ──────── after S2 ────
```

Sync points are where tracks must merge before continuing (e.g., frontend needs the API to exist before integration). The coordinator runs the sync — subagents don't wait on each other directly.

**Label tracks "Subagent track N" — never "Agent N" or "Person N".** Past plans used "Agent/Track" wording and one user opened 3 parallel Claude Code sessions thinking the plan called for it. The git race was not pretty.

**If the project is large enough to need multiple sessions**, restructure the plan so each sprint can ship to main independently:
```
Session 1: Sprint 1 (setup) — ships to main
Session 2: Sprint 2 (backend) — depends on Sprint 1 having shipped
Session 3: Sprint 3 (frontend) — depends on Sprint 1, can be same/diff session as Sprint 2
Session 4: Sprint 4 (integration) — depends on Sprints 2 + 3 shipped
```
Within each session, subagent-parallelism still applies for independent tasks in that sprint.

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

### Phase 3.5: Model recommendation

For each sprint, recommend which Claude model to use:

- **Opus** — Architecture decisions, complex refactors, multi-file changes, anything where getting it wrong wastes hours. Default for most implementation work.
- **Sonnet** — Straightforward tasks with clear specs: config changes, data fixes, adding fields, routine CRUD, CI/workflow tweaks, running existing scripts. Faster and cheaper when the task is well-defined.

Add a `MODEL:` line to each sprint header. Example: `MODEL: Sonnet — straightforward data migration with clear schema`

### Phase 4: Critique the plan

Use `/plan-review` to run the full multi-model critique (GPT-4o + Gemini + Claude agent + pre-mortem) on your sprint plan. This gives you 4 independent perspectives with differentiated focus areas.

If `/plan-review` is not available, use the Task tool with subagent_type "general-purpose" to run an independent review:

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

## Subagent Execution Map (within one /execute-plan session)
[Show how independent tasks within one session can be split across subagents. **Do NOT split tracks across separate Claude Code sessions — that breaks git history.** See Phase 2b warning.]

Subagent track 1:  S1-T1 → S1-T3 → S2-T1 → ...
Subagent track 2:  S1-T2 → S1-T4 → S2-T2 → ...
Sync:              ──── after S1 ──── after S2 ────

**Parallel sprints (subagent-level, same session):** [List any sprints that have no file overlap and can run as concurrent subagent tracks]
**Critical path:** [The longest sequential chain — how many sessions minimum if executed one sprint per session?]
**Max subagent parallelism:** [How many subagents could a single coordinator agent run concurrently at peak]
**Cross-session plan:** [If the work spans >1 session, list which sprint each session takes. Each session runs one sprint to ship-and-push completion before the next session starts.]

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

### Notion Update (BWSC projects only)

After writing the plan file, update the session's Notion card:
1. Append to Outcome: `### Plan created\n[Sprint count, task count, key risks — 3-4 lines max]`
2. This ensures the plan survives if the session is interrupted before implementation begins.
