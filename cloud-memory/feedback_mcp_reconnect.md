---
name: MCP reconnection via resume
description: Exiting and resuming a CC session reconnects dropped MCP servers (Notion, Gmail, Calendar). No need to start fresh.
type: feedback
archived: true
---

When Notion MCP (or other cloud MCPs) disconnect during a long session, exit and resume the session — this reconnects them. No need to start a completely new session.

**Never tell the user to paste things into Notion manually.** If Notion MCP is down, suggest exit+resume to reconnect. If that fails, hold the Outcome text in the conversation and retry after reconnect. The user is non-technical and often on phone — manual Notion updates are not acceptable.

**Why:** Discovered during Notion Brain setup (2026-03-27). Confirmed again 2026-03-28: exit+resume restored Notion MCP after it dropped mid-session. Outputting "paste this into Notion yourself" violates the global rule of never asking user to do things you can do.

**How to apply:** When any MCP tool fails with a connection error:
1. Suggest user exit+resume (reconnects MCP)
2. After reconnect, retry the Notion update
3. Never output Outcome text for manual paste as a first resort
