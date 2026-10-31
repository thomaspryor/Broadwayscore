---
name: JSON conflict marker grep must not use ^ anchor
description: Conflict markers in nested JSON are indented — grep pattern must match anywhere on line, not just column 0
type: feedback
archived: true
---

When grepping for git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in JSON files, never use `^` anchor. In nested JSON, conflict markers are indented with spaces. `^(<{7}|={7}|>{7})` misses them — use `(<{7}|={7}|>{7})` instead.

**Why:** Original deploy validation used `^` anchor, which would have missed the exact incident it was designed to prevent (audience-buzz.json had indented markers inside nested objects). Caught during testing with diverse cases.

**How to apply:** Any future grep-based conflict detection in workflows, hooks, or scripts. Also applies to the existing `push-core-data` action (line 56) which uses `grep -q '<<<<<<'` (no anchor — correct, but only checks one marker type).
