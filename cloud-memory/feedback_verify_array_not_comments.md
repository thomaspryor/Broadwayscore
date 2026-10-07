---
name: Verify array contents, not just comments
description: When verifying a field was removed from an array (PROTECTED_FIELDS, etc.), grep the array itself — not the comments
type: feedback
originSessionId: f075b39c-5209-433b-968f-4c9c8f138cf2
archived: true
---
When a session claims to have "removed X from PROTECTED_FIELDS," grep the actual array entries, not the explanatory comment.

**Why:** Card #1 session added a comment: "incompleteReason intentionally NOT in this list" while leaving the actual `'incompleteReason'` entry in the PROTECTED_FIELDS array. The comment and the code contradicted each other. The bug persisted undetected until QA review in the next session (2026-04-18).

**How to apply:** When reviewing or verifying field-removal work:
```bash
grep "incompleteReason\|fieldName" scripts/lib/review-write-guard.js
```
Don't trust commit messages or comments. Read the actual array. Same applies to any allowlist/blocklist/skiplist changes — verify the data structure, not the prose around it.
