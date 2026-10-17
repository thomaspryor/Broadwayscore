---
name: Session-start staleness check for private-repo data
description: Hook warns at startup if data/review-texts is behind/ahead/diverged/dirty vs origin, surfacing stale-data issues before the session's first tool call
type: feedback
originSessionId: a888b2ec-9af0-421d-8ea2-44d03167b5f1
archived: true
---
The pattern: many sessions burn context on a false diagnosis ("these files are missing!" / "the enrichment isn't finding matches") before realizing `data/review-texts` is stale. The poller pushes to that private repo 10s of times per day; any session older than ~20 min can be behind.

**Why:** on 2026-04-24 a session doing RHPS DTLI thumb enrichment reported "14 missing critic files." 11 of 14 already existed — local was 3 commits behind origin. That burned ~30 min of context on the wrong diagnosis.

**How to apply:**

- `~/.claude/hooks/session-start.sh` now invokes `scripts/sync-review-texts.sh --check-only` on the `startup` event (not `clear`/`compact`). If state is `behind` / `ahead` / `diverged` / `dirty`, a stderr warning surfaces before Claude's first tool call with the exact command to fix it.
- The hook is passive — it only warns. It does NOT auto-pull. Reasoning: auto-pull can silently merge unpushed local commits (incident this session: `d67002e89`), and `--ff-only` would fail on the rebase-push pattern the CI uses anyway.
- If you see a staleness warning at session start, run the suggested command BEFORE any enrichment/audit work. Examples:
  - `behind` → `cd data/review-texts && git pull --ff-only origin main`
  - `diverged` → `cd data/review-texts && git pull --rebase origin main` (then `--theirs` any conflicts)
  - `dirty` → commit or stash; check what's staged
- Latency budget: 0.08s for `clear`/`compact` (skipped), 0.57s for `startup` (includes 5s-cap fetch). If network is down, reports `state=nofetch` and stays silent.

**What this DOESN'T fix:** the hook is cold-start-only. If the poller pushes 50 commits during a 4-hour session, the session will still drift silently. For mid-session drift, pull manually before any enrichment/audit operation — don't trust a 2-hour-old local checkout.

**Files:**
- Hook: `~/.claude/hooks/session-start.sh` (claude-config repo, commit `7386d8d`)
- Script: `scripts/sync-review-texts.sh` `--check-only` mode (Broadwayscore, commit `79bccac7b0`)
- Test harness: `scripts/lib/test-sync-check.sh` (11 state-detection tests)
