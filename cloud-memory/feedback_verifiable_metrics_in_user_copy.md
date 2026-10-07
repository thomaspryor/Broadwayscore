---
name: Verifiable accuracy/backtest metrics in user-facing copy must be reproducible from repo
description: If the user supplies a precise metric (X% accuracy, N% improvement, K-fold cross-validation), don't put it in user-facing copy unless a script in the repo can reproduce it. Soften to a verifiable equivalent if not.
type: feedback
originSessionId: 66fe2dde-3129-4b57-83b6-1c52c5414cdd
archived: true
---
If a user supplies a precise number (92.9% accuracy, +8pts improvement, "leave-one-season-out cross-validation") for inclusion in user-facing copy, FAQ schema, or marketing text, only put it in writing if a committed script can reproduce it. If not, soften to a number that IS reproducible.

**Why:** Caught by /ship-check on Tony predictor 2026-04-29. User provided "92.9% LOSO" from external backtest reports in `~/Documents/claude-outputs/`. I put it in 4 places (FAQ schema, page tagline, "How This Works" panel, code comment). Two reviewers (general-purpose + Codex) flagged: no LOSO script exists in repo, so a reader can't reproduce. Worse: for OUR specific recipe (constants, not per-fold trained), LOSO == in-sample mathematically — the 92.9% must have come from a DIFFERENT recipe found via tuning that wasn't shipped. Soften to "42 of 43 contests" which IS reproducible from `scripts/audit-tony-all-seasons.ts`. Per CLAUDE.md "Never guess or fake data" — extends to "if a verifiable script doesn't exist, don't claim a precise number you can't reproduce."

**How to apply:** Before pasting a user-supplied accuracy/backtest figure into copy: (1) check if a script in `scripts/` reproduces it; (2) if not, either add a script that does, OR soften the copy to whatever IS verifiable (in-sample audit, count of correct picks). Keep external reports as the source of truth in the code-comment header but don't quote precise figures from them in user-visible text.
