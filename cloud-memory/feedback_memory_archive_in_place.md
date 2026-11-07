---
name: archive memory files in place
description: Don't git-mv memory/*.md files to memory/archive/ — source-code comments across scripts/ reference them by path. Use archived:true frontmatter instead.
type: feedback
originSessionId: 96a5cc07-46ce-4ec1-a2fe-07a70b48b334
---
When cleaning up stale or orphan memory entries, never move them into a subdirectory like `memory/archive/`.

**Why:** ~100s of source-code comments across `scripts/` reference these files by relative path (e.g., `// see memory/feedback_X.md`, `console.log('• Methodology: see memory/feedback_X.md')`). A move silently invalidates every one of those pointers. A future reader follows the broken path and concludes the rule no longer exists.

**How to apply:**
- Use `archived: true` in the frontmatter to remove a file from rebuild-memory-index output without breaking grep or hardcoded path refs
- `rebuild-memory-index.js` already honors `archived: true` (skips the file during index generation)
- Reversible: remove the `archived: true` line to promote the entry back into the rebuilt index
- This came up shipping the May 16 enforcement gates (256 orphans archived in place after pre-flight grep caught the broken-comment risk)
