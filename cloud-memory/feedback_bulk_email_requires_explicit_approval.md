---
name: feedback_bulk_email_requires_explicit_approval
description: Never run a bulk email script without explicit user approval AND a real --dry-run flag that prevents sending
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 965a4bd3-9c8a-43d0-9429-d669ba57b775
---

Never run any script that sends emails to real users without:
1. An explicit `--dry-run` flag that actually prevents sending (not just a comment)
2. The user explicitly saying "send them" or "run it"

**Why:** On 2026-06-07, wrote a bulk confirmation email script, labeled the run "dry run first" in a comment, and ran it against production Resend without a real guard. 6 real emails went to contest entrants without user approval. This directly violated the email broadcast safety rules.

**How to apply:** Any script that calls Resend (or any email API) must default to dry-run mode. Add `const DRY_RUN = process.argv.includes('--send')` — dry run by default, only sends with explicit `--send` flag. Show the user the list of recipients and ask for approval before running with `--send`. "I'll do a dry run first" means nothing if the code sends anyway.
