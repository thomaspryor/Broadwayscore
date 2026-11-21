---
name: Save actionable findings from research sessions
description: "After last30/web research, immediately save actionable ideas to memory."
type: feedback
---

After any research session that produces actionable recommendations (e.g., `/last30`, competitive analysis, user research), save the key findings to a memory file BEFORE the conversation ends.

**Why:** A last-30-days research session produced improvement ideas that were discussed but never saved. When the user asked about them in the next session, they were gone. Research is expensive to redo and findings are exactly the kind of cross-session context memory exists for.

**How to apply:**
- After any research skill (`/last30`, `/last30days`, web searches producing recommendations): create a `project_research_{topic}_{date}.md` memory file with the key findings, recommendations, and any decisions made
- Don't save the raw research — save the distilled actionable takeaways
- Tag with the date so staleness is obvious
- This applies to ANY conversation output that the user might want to reference later and can't easily re-derive from code or git
