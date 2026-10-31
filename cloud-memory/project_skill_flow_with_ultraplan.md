---
name: Skill flow with ultraplan
description: "Task routing by size; ultraplan replaces generation, not review."
type: project
originSessionId: ad6ae4f1-a05f-4476-8297-de02914b6dd0
archived: true
---
## Updated Skill Flow (post-ultraplan, 2026-04-12)

/ultraplan generates plans faster (4 cloud Opus agents, browser review) but skips domain safety gates. The `/ultraplan-review` bridge skill validates ultraplan output through our 6-reviewer pipeline before execution.

### Task routing by size

**Tiny (bug fix, single file, <30 min):**
```
/session-start → just do it → /did-it-work → /build-check → /done
```
No planning needed. Skip ultraplan, skip /plan-review.

**Small (<8 tasks, <=3 files, 1 session):**
```
/session-start → /second-opinion → implement → /did-it-work → /ship-check → /done
```
Or if uncertain about approach:
```
/session-start → /right-problem → implement → /did-it-work → /ship-check → /done
```

**Medium (8-20 tasks, 4-10 files, 2-4 sessions):**
```
/session-start → /ultraplan → /ultraplan-review → /plan-tasks → /execute-plan → /did-it-work → /ship-check → /wrap-up
```
Ultraplan replaces the initial plan generation. /ultraplan-review adds our domain safety gates. /plan-tasks breaks into atomic commits.

**Large (20+ tasks, 10+ files, 5+ sessions, architecture decisions):**
```
/session-start → /right-problem → /ultraplan → /ultraplan-review → /plan-tasks → /execute-plan → /did-it-work → /ship-check → /wrap-up
```
/right-problem validates the approach BEFORE ultraplan burns cloud compute on the wrong direction.

### Key principle
Ultraplan replaces plan GENERATION, not plan REVIEW. The browser UI makes plans look authoritative — our review pipeline catches what the 4 cloud agents can't: domain rules, data races, worktree requirements, scoring conventions, private repo coordination.

### When ultraplan wins over local /plan
- Multi-file changes where one wrong assumption cascades
- Architecture decisions with multiple valid approaches
- Plans you need to share/discuss (browser URLs)
- Complex plans worth 20+ min of review (inline comments beat terminal)

### When to skip ultraplan
- Already know exactly what to change
- Project not on GitHub
- Offline / no cloud
- Change is smaller than the planning overhead (<3 files)
