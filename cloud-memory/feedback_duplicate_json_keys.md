---
name: Duplicate JSON keys — last value wins silently
description: When editing review-text JSON files manually, adding a field that already exists elsewhere in the file creates a duplicate key where the last value wins, silently ignoring the first
type: feedback
originSessionId: 41011087-ab38-4d77-aa60-6a75438b8601
archived: true
---
`JSON.parse()` last-key-wins for duplicate keys. When manually adding `wrongProduction: false` to a review file to override the date guard, if the file already has `wrongProduction: true` further down, the file will still read as `true` after parsing.

**Why:** This burned the Observer/Heilpern fix — added `wrongProduction: false` near the top but the original `wrongProduction: true` from the date guard (line 58) remained. The review stayed excluded for multiple rebuild cycles.

**How to apply:** When editing review-text JSON files to clear a flag, grep for all occurrences of the field name before saving. Use `grep -n "wrongProduction" filename.json` to find duplicates. The Edit tool's diff output won't show you the existing duplicate.
