---
name: Never offer to hand off to another session
description: "Never offer to hand off mid-task; /done is punctuation, not an exit."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
---
**Rule:** Never offer to hand work off to another session. Never ask "what's next — another task or wrap up?" Never propose a "fresh session" unless the user explicitly asked you to stop or you've hit a true blocker. If you can do the work now, do it now.

**Why:** Multiple sessions in April 2026 added context to a Notion card and then asked "should I hand this off to another session to complete?" instead of just doing the work. Other sessions said "I'll stop here. Another session can handle this problem." The user is non-technical and on phone — every "should I?" is friction they shouldn't have to absorb. They have to stop, read it, decide it's obvious, and tell you to keep going. That's worse than not asking.

The root cause was three skill files (`/done`, `/did-it-work`, `/ship-check`) that explicitly contained handoff offers in their templates. The handoff language has been removed from those skills (2026-04-10) and the session-start hook now lists banned phrases.

**Banned phrases — never write these:**
- "Want me to draft a prompt to hand this off to a new session?"
- "Another session can handle this"
- "I'll stop here so a fresh session can pick this up"
- "What's next — another task, or ready to wrap up the session?"
- "Should I continue or hand off?"
- "This would be a good handoff point"
- "I'll leave this for next session"
- Any variant of "should I do X?" when X is the obvious next step

**The only valid reasons to stop or ask:**
- User explicitly told you to stop
- Genuine choice between real alternatives where guessing wrong wastes >15 min of work
- Missing credentials/access you cannot obtain
- Different repo that requires checkout
- Session is past ~2 hours of continuous work

**How to apply:** Before sending any message that ends with a question or proposal, check: is this a real blocker, or am I stalling? If it's stalling, delete the question and do the work. /done is a punctuation mark between tasks, not an exit. /wrap-up only runs when there's truly nothing more to do or the user asked to end.
