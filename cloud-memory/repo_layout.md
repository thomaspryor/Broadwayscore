---
name: multi-repo-layout
description: "Three repos (web, iOS app, data) with their GitHub names and local directory paths"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1cf6c1e7-687a-4f11-917f-6de65baaef84
  modified: 2026-09-16T02:36:15.258Z
---

Broadway Scorecard spans three repos:

| Repo | GitHub | Local dir |
|------|--------|-----------|
| Web | thomaspryor/Broadwayscore | ~/Broadwayscore/ |
| iOS app | thomaspryor/BroadwayScorecard-app | ~/BroadwayScorecard-app/ |
| Data | thomaspryor/broadway-scorecard-data | ~/broadway-scorecard-data/ |

**Why:** Previously the iOS app repo was at ~/BroadwayScorecard/ which was ambiguous. Renamed 2026-03-22 to match the GitHub repo name.

**How to apply:** Use these paths when referencing cross-repo files or suggesting commands. The web repo's CLAUDE.md is gitignored; cross-references live in README.md instead.

**Cowriter is a fourth, separate side project** (thomaspryor/cowriter, ~/Cowriter/) — an AI musical-theater co-writer app, unrelated to Broadwayscore's stack. Linear/Notion cards mentioning "Cowriter" (e.g. BRO-1284) file under the Broadwayscore Linear workspace for tracking but the actual code lives in ~/Cowriter, not this repo — check there first, don't assume the card is about Broadwayscore. It uses its own `.claude/worktrees/<name>` git-worktree convention and has no test runner set up beyond ad-hoc `node --test tests/unit/*.test.mjs` (added 2026-09-15).
