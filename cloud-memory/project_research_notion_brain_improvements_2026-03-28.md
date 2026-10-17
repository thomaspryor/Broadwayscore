---
name: Research — Notion Brain improvement ideas (2026-03-28)
description: "7 ideas from last30: custom agents, per-subagent memory, teams."
type: project
archived: true
---

## Research Date: 2026-03-28

### Idea 1: Use Notion Custom Agents (3.3) alongside Claude Code
Notion 3.3 (Feb 2026) shipped Custom Agents — autonomous agents that run inside Notion on triggers/schedules. They can react to database changes (page added, updated, removed), comments, and @mentions. 21,000+ agents built in early beta.

**Opportunity:** Instead of polling every 3 hours, a Notion Custom Agent could instantly react when Action is set on a card and ping a webhook or write to a trigger file that launchd watches. Near-instant dispatch instead of 3-hour polling.

**Caveat:** Requires Business plan. Free through May 3, 2026.

### Idea 2: Per-subagent memory (Claude Code v2.1.33+)
Claude Code now supports a `memory` frontmatter field on subagents — each gets its own persistent markdown knowledge store. The subagent's MEMORY.md is auto-loaded (first 200 lines / 25KB).

**Opportunity:** Create specialized subagents (scraper-agent, scoring-agent, opening-night-agent) that accumulate domain knowledge across sessions. E.g., the scraper agent remembers which sites need TLS workarounds, the scoring agent remembers prompt tuning decisions.

### Idea 3: Replace "some friends deleted Notion/Linear" pattern
Reddit thread (r/ClaudeCode, 45 upvotes) about teams using Claude Code as the entire work hub — markdown files, sync scripts, no external PM tool. Counter-pattern to our Notion Brain.

**Takeaway:** We're doing the right thing keeping Notion as source of truth (phone access, push notifications, non-technical UI). But we should ensure the Claude Code side is self-sufficient when Notion is unreachable — our graceful degradation already handles this.

### Idea 4: CCPM (Claude Code Project Management) skill
Open-source skill (github.com/automazeio/ccpm) that uses GitHub Issues + git worktrees for parallel agent execution. Activates on PM intent — no special syntax.

**Opportunity:** Evaluate whether CCPM's GitHub Issues approach offers anything our Notion-based system doesn't. Likely not — Notion is richer — but the "auto-detect PM intent" pattern is interesting.

### Idea 5: Agent Teams for parallel implementation
Claude Code "Agent Teams" feature — a lead agent spawns multiple specialized agents working in parallel on a shared codebase. Orchestrator-subagent model.

**Opportunity:** For "Start" action cards that touch multiple subsystems, the Action Dispatcher could spawn parallel subagents (frontend, backend, data) instead of one serial session. Would dramatically speed up large implementations.

### Idea 6: Notion as webhook trigger → instant dispatch
Notion Custom Agents can trigger on database changes. Combined with our Action Dispatcher:
1. User sets Action on card in Notion
2. Notion Custom Agent detects the change instantly
3. Agent writes to a webhook/file/Slack that triggers local Claude session
4. Response time drops from up to 3 hours to under 1 minute

### Idea 7: Self-updating agent memory
Notion's own agents "self-update their own memory for enhanced autonomy." Our Action Dispatcher should do the same — after each session, the agent should update its own memory files with patterns it learned (which scripts failed, which approaches worked).

**How to apply:** Add a post-processing step in notion-action-poll.js that asks Claude to also output memory updates, then writes them to the appropriate memory files.
