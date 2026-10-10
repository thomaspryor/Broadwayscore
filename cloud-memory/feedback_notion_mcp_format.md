---
name: Notion MCP API format quirks
description: "Tags as comma-string not array; update-page needs command+content_updates."
type: feedback
archived: true
---

Notion MCP tools have non-obvious parameter requirements:

1. **Tags (multi_select):** Pass as comma-separated string, NOT an array. `"Tags": "opening-night"` not `"Tags": ["opening-night"]`
2. **update-page:** Requires `command` field (`"update_properties"`, `"update_content"`, `"replace_content"`) AND `content_updates` (empty array `[]` if only updating properties)
3. **Valid Tags values:** scoring, scraping, opening-night, west-end, off-broadway, commercial, email, ios-app, infra, data-quality, seo, audit, data
4. **create-pages parent:** Use `data_source_id` (not `database_id`) for BWSC Roadmap: `fa7b3ff2-c073-4097-b54c-0a78e56e06b6`

**Why:** These caused 3 failed API calls in the 2026-04-05 session, visible to user as MCP errors.

**How to apply:** Always use these formats on first attempt. Don't guess — reference this memory.
