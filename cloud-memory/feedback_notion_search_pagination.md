---
name: notion-brain search uses two-tier: server-side title filter + paginated fallback
description: Post-2026-04-24 fix. `search --text` now uses a server-side Name contains filter as a fast path, then paginates (cap 20 pages = 2000 cards) to catch notes-body matches. Before this, cards past position 100 were invisible to --text.
type: reference
originSessionId: da56c300-b775-46c0-8002-605c96f23b84
archived: true
---
After 2026-04-24 (commit 0b9d3e7e9c), `scripts/notion-brain.js search` works correctly for any card size. Before the fix, the search did a single 100-card API call sorted by Priority-asc then filtered client-side, so P1+ Not-started cards were invisible when the first 100 slots were full of P0 cards. A session lost 30+ minutes searching for the Backfill 308 NY Post card because of this bug.

## How it works now
1. **Tier 1 — fast path:** When `--text` (or `--query`, aliased) is given, builds a server-side filter: `Name contains <needle>` AND'd with existing `--status`/`--priority` filters. One Notion API call returns only matching cards. Scales regardless of DB size.
2. **Tier 2 — notes body fallback:** If Tier 1 returns zero hits, paginate the base filter (up to 20 pages = 2000 cards) and run the client-side name||notes filter. Catches text matches that live only in the notes body.
3. **No-text-filter path:** Single page, priority-asc. Preserves old cheap behavior for listing calls.

## Debugging tips
- If search returns no hits and you know a card exists: try `get <id>` to confirm, then try `--status` or `--priority` to narrow server-side. If both find the card but `--text` doesn't, the text doesn't match name OR notes — might be only in Outcome/Key Files/Tags (not covered by the client-side filter).
- If the DB grows past 2000 cards, bump PAGE_CAP in `searchCards` at scripts/notion-brain.js:586.
- `--query` is aliased to `--text` because a prior session's handoff notes falsely claimed --query worked. Aliasing makes the advice non-harmful.

## When NOT to use --text
- Listing all cards matching a status/priority — just use `--status`/`--priority` alone; tier 1 doesn't run, tier 2 paginates only if needed.
- Counting total cards in DB — use direct API query, not the CLI.
