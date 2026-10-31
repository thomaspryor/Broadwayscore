---
name: Notion cards must be self-contained handoffs (CLI-enforced)
description: "Cards are self-contained handoffs: paths, commands, root cause, acceptance."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
---
**Enforcement update (2026-04-11):** The rule below is now enforced at the CLI level in `scripts/notion-brain.js`. Audit of 5 recent active cards showed 3 of them had **zero** notes despite this rule existing for 5+ days. The rule was aspirational only — sessions ignored it. Now the CLI rejects sparse cards with exit 2 before they reach the Notion API:
- **Any card:** notes cannot be empty (rejected: `EMPTY_NOTES`)
- **In-progress cards:** need ≥80 chars (rejected: `TOO_SHORT`)
- **Backlog cards (Not started, Paused):** need ≥300 chars AND sections matching Problem / Suggested approach / Acceptance criteria (rejected: `INCOMPLETE_HANDOFF`)
- **Bypass:** pass `--force "<reason ≥10 chars>"` — the reason is logged to stderr so the review is visible. Use only for genuine session markers that will be filled in on wrap-up.

On rejection, the CLI prints the full card template so you can copy-paste it into `--notes`. Exit code 2 means you MUST address the notes before retrying — there is no workaround short of `--force` with a real reason.

Every Notion card created for future work must be a self-contained handoff — a fresh session should be able to start executing within 2 minutes, not spend 30 minutes rediscovering what the creating session already knew.

**Why:** Session on 2026-04-06 created 6 roadmap cards with thin descriptions like "P2: Fix london-theatre recollect errors — 63 errors per run." A new session picking this up would need to: find which script, run it, see the errors, figure out the pattern, understand the root cause — all things the creating session already knew. The session itself admitted "Not really" when asked if the cards had sufficient context.

**How to apply:** Before creating any Notion card for discovered/future work, apply this checklist:

### MANDATORY card Notes template (all card types):
```
## Problem
[What's wrong or what's needed — specific, not just a label]

## Evidence
[Show IDs, error counts, log snippets, URLs — whatever proves the problem exists]

## Root cause (if known)
[Why it happens — the creating session often figured this out but didn't write it down]

## Suggested approach
[What the creating session would have done if they had time. Include:
- Exact file paths to modify
- Commands to reproduce/verify
- Gotchas discovered during investigation]

## What was already tried
[Anything the creating session attempted that didn't work, so the next session doesn't repeat it]

## Acceptance criteria
[How to verify the fix is complete]
```

### Self-check before saving:
Ask: **"If I were a fresh session with zero context, could I start working on this in under 2 minutes?"**
- If no → add the missing context
- If the answer is "they'd need to run X to understand" → run X now and paste the output into the card

### Bad vs Good examples:

**Bad:** "P2: Fix london-theatre recollect errors — 63 errors per run"
**Good:** "P2: Fix london-theatre recollect errors — 63/run are CAPTCHA blocks"
Notes: "## Problem\nrecollect-for-scores.js fails on ~63 london-theatre URLs per run with CAPTCHA challenge pages.\n\n## Evidence\n`node scripts/recollect-for-scores.js --market=west-end --outlet=london-theatre --dry-run 2>&1 | grep -c CAPTCHA` → 63\nSample URLs: [3 examples]\n\n## Root cause\nlondon-theatre.co.uk has Cloudflare CAPTCHA on high-frequency requests. fetchPage() BD proxy doesn't solve it.\n\n## Suggested approach\nUse Browserbase or local Playwright with stealth plugin. File: scripts/recollect-for-scores.js:L142 (the fetchPage call for london-theatre).\n\n## Acceptance criteria\n`--outlet=london-theatre` run returns >50% success rate."

**Bad:** "P1: Find 20 Daily Mail URLs — manual lookup needed"
**Good:** "P1: Find 20 Daily Mail review URLs — DM search broken, not Google-indexed"
Notes: "## Problem\n20 WE reviews from Daily Mail have no URL. DM's internal search doesn't work for theatre reviews, and Google hasn't indexed them.\n\n## Evidence\nShows: [list of 20 show IDs]. Run: `grep -rl '"outlet": "daily-mail"' data/review-texts/ | xargs grep -L '"url"' | wc -l` → 20\n\n## What was already tried\n- Google SERP: returns wrong articles (celebrity gossip, not reviews)\n- DM search: returns 0 results for 'theatre review [show name]'\n- archive.org: DM blocks Wayback Machine\n\n## Suggested approach\nManual: search DM website directly for each show title + 'review'. May need to browse by date if search fails. Can batch 5 at a time.\n\n## Acceptance criteria\nAll 20 files have valid `url` fields pointing to the actual review page."
