---
name: Notion card at session start
description: Create Notion card IMMEDIATELY when user states focus — don't wait for wrap-up or user reminder
type: feedback
archived: true
---

Create the Notion card as soon as the user states their focus. Don't wait until wrap-up. Don't wait for the user to ask.

**Why:** User had to ask "All this is updated in Notion?" at the end of a full session because the card was never created. The rules in CLAUDE.md §6 and the startup hook both say to do this immediately. Missing it means the session is invisible in the project brain until someone notices.

**How to apply:** After the user's first message that states a task/focus:
1. Create Notion card (Status: "In progress", name from user's focus)
2. Output the card URL
3. At wrap-up, update with Outcome + set "Done"

This is not optional and should happen before any implementation work begins.
