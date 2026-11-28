---
name: ios-worktree-env-local-missing
description: ".env.local (gitignored) doesn't come along in a BroadwayScorecard-app git worktree — source it via the main repo's absolute path when a worktree build needs real local dev secrets"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 57ecda6f-dc96-40ff-88d4-b12c8c192c3c
  modified: 2026-07-20T22:38:06.635Z
---

`.env.local` in `~/BroadwayScorecard-app` holds real dev/test secrets (Supabase URL/anon key, dev-test account creds) and is gitignored, so `git worktree add` never carries it into the worktree checkout. A worktree build that does `source .env.local` fails with "no such file" even though the file clearly exists — because it exists in the main repo root, not the worktree.

**Fix:** reference it by absolute path from the worktree: `source /Users/tompryor/BroadwayScorecard-app/.env.local`. Same applies to any other gitignored local-only file (cookies, `.env*.local` variants).

**Why it matters:** distinct from [[feedback_expo_worktree_node_modules.md]] (node_modules gap) — this is about *environment/secret* files specifically, not installed deps. Both gaps hit together when a worktree needs to run a real local build (prebuild + pod install + xcodebuild), not just `tsc`/lint.

**Also confirmed this session:** a fresh `npm ci` directly in an Expo app worktree (not symlinking node_modules) completed in ~32s — cheap enough to just do the real install when the worktree needs `expo prebuild`/pod install/xcodebuild (symlinking node_modules alone isn't sufficient for those anyway, per the linked memory's own caveat about `expo export`).

**How to apply:** before sourcing any `.env*` file or copying cookies/credentials into a worktree build, check whether the file is gitignored (`git check-ignore <file>`) — if so, reference it via the main repo's absolute path rather than assuming it's present in the worktree.
