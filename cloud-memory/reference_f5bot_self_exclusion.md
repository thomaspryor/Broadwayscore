---
name: reference_f5bot_self_exclusion
description: "F5Bot keyword syntax to exclude the owner's own Reddit posts from alerts; F5Bot login creds are not accessible to Claude (not in GH secrets or .env)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 436cb2f9-d85b-4aea-997f-2a370102551e
  modified: 2026-07-31T18:10:57.315Z
---

F5Bot (f5bot.com) supports an `exclude-username=` flag appended to a tracked keyword, e.g. changing the "broadwayscorecard" keyword to:

    broadwayscorecard exclude-username=thomaspryor

This drops future alerts where the Reddit post author is that exact username (exact match only, per F5Bot's power-user docs at f5bot.com/docs-power). Confirmed 2026-07-31 via F5Bot's own docs pages — not verified to actually work in the live dashboard.

**Why Claude can't apply this directly:** F5BOT_EMAIL/F5BOT_PASSWORD are referenced in an old memory note but are NOT present in `gh secret list --repo thomaspryor/Broadwayscore`, not in `.env`/`.env.local`, and no password manager CLI (`op`) is installed on this machine. There is no programmatic login path — this is a genuine case where only the user can make the change (2026-07-31, second time asked; user should log into f5bot.com and edit the keyword directly).

**How to apply:** If the user asks again to exclude their own posts from F5Bot, give them the exact `exclude-username=thomaspryor` edit instead of re-researching — don't re-run the WebFetch/WebSearch discovery. If F5Bot credentials ever get added to a password manager or GH secrets, this becomes DIY-able (log in, edit keyword, done).

The internal `scripts/lib/owner-accounts.js` `OWNER_ACCOUNTS.reddit` list (thomaspryor, thepinkmusical, broadwayscorecard, bwayscorecard) already filters these same accounts out of BWSC's own brand-mention-monitor pipeline — F5Bot is a fully separate, independent alerting channel with no shared config.
