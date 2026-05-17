---
name: Multi-repo layout
description: Three repos (web, iOS app, data) with their GitHub names and local directory paths
type: project
---

Broadway Scorecard spans three repos:

| Repo | GitHub | Local dir |
|------|--------|-----------|
| Web | thomaspryor/Broadwayscore | ~/Broadwayscore/ |
| iOS app | thomaspryor/BroadwayScorecard-app | ~/BroadwayScorecard-app/ |
| Data | thomaspryor/broadway-scorecard-data | ~/broadway-scorecard-data/ |

**Why:** Previously the iOS app repo was at ~/BroadwayScorecard/ which was ambiguous. Renamed 2026-03-22 to match the GitHub repo name.

**How to apply:** Use these paths when referencing cross-repo files or suggesting commands. The web repo's CLAUDE.md is gitignored; cross-references live in README.md instead.
