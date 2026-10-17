---
name: Two local review-text directories cause silent stale reads
description: "Edits to /Users/tompryor/broadway-review-texts/ DON'T propagate to /Users/tompryor/Broadwayscore/data/review-texts/ which is what local rebuild reads."
type: feedback
originSessionId: b2030ae3-d1b1-48aa-bbf4-b0db0216c7c2
archived: true
---
Two physical review-text trees exist on disk:
- `/Users/tompryor/broadway-review-texts/` — private repo, source of truth, what gets pushed
- `/Users/tompryor/Broadwayscore/data/review-texts/` — local working copy, what `scripts/rebuild-all-reviews.js` reads

These are NOT linked. Edits to one do NOT appear in the other. A common failure mode: edit a review file in the private repo, commit/push, run local rebuild → rebuild silently reads the stale Broadwayscore copy and produces a reviews.json that doesn't reflect the edit.

**Why:** Per `setup-local-data.sh`, the Broadwayscore copy is initialized once and not auto-resynced. CI pulls fresh from the private repo, so CI rebuilds are correct — but local rebuilds drift.

**How to apply:**
- Before any local `node scripts/rebuild-all-reviews.js`, sync first: `cp /Users/tompryor/broadway-review-texts/{show-id}/{file}.json /Users/tompryor/Broadwayscore/data/review-texts/{show-id}/{file}.json` (or `rsync -a /Users/tompryor/broadway-review-texts/ /Users/tompryor/Broadwayscore/data/review-texts/` for bulk).
- After local rebuild, copy reviews.json TO the private data repo (`/Users/tompryor/broadway-scorecard-data/reviews.json`) and push from there.
- Symptoms of stale-read: rebuild log says "fallen-angels-2026: 21 reviews" but `python3 -c "..."` on the resulting reviews.json shows the OLD field value. Confirm by `diff` between the two `data/review-texts/{show}/{file}.json` paths.

Tracked for permanent fix in Notion `348637c5-416f-81cd-be2e-e5fe8a205457` — symlink the local copy to the private repo, or have rebuild read from the private path directly when it exists.
