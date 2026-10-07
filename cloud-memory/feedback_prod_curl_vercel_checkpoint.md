---
name: prod-curl-vercel-checkpoint
description: Rapid curl-polling broadwayscorecard.com trips Vercel Security Checkpoint (challenge HTML instead of JSON) — verify prod data via committed public JSONs or check-prod-deploy.js, never curl loops
metadata:
  type: feedback
---

Burst curl requests to broadwayscorecard.com (~10+ in quick succession, e.g. a per-show verification loop) trigger Vercel's Security Checkpoint: every response becomes a challenge HTML page ("Vercel Security Checkpoint") for several minutes, so JSON parsing fails and prod looks broken when it isn't. Hit 2026-07-13 during batch #109 prod verification.

**Why:** the checkpoint is IP-based bot protection; it blocks the exact rate a verification loop produces, and the challenge page returns 200 so status-code checks pass while content checks fail.

**How to apply:**
- Verify deployed DATA from the repo: `public/data/shows/{id}.json` and `node scripts/generate-search-shows.js` output are what the next build serves — no network needed.
- Verify DEPLOYMENT state via `node scripts/check-prod-deploy.js HEAD [--wait]` (Vercel API + token, immune to the checkpoint).
- If prod content must be curled, space requests 30s+ and cap the count; on challenge HTML, wait ~5 min — do not retry-loop.
