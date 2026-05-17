---
name: Vercel read-only filesystem
description: "API routes must never writeFileSync data files; submit to external services."
type: feedback
archived: true
---

API routes on Vercel cannot write to the filesystem. `readFileSync`/`writeFileSync` on `data/*.json` either throw or succeed transiently but are lost on next invocation. The Buttondown webhook was silently losing unsubscribes for months because of this.

**Why:** Vercel serverless functions run in ephemeral containers with a read-only filesystem (except `/tmp`). Files written to `data/` persist for the container lifetime (~5 min) then vanish.

**How to apply:** When an API route needs to persist data, submit to an external service (Formspree, Resend, etc.) and let a CI workflow (sync-followers.js) handle the file writes in a proper git context. Never write to `data/` from `src/app/api/`.
