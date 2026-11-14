---
name: Layout head tag edits get silently removed by formatter
description: "Prettier silently removes manual <head> edits; git diff after hook."
type: feedback
archived: true
---

Edits to `<head>` in `src/app/layout.tsx` get reformatted by the prettier hook on save. The RSS auto-discovery link was added, committed, but then silently removed by the formatter in a subsequent commit.

**Why:** The prettier hook runs after every Edit tool call on .tsx files. It can reformat or remove manual `<head>` additions that don't match its expected patterns.

**How to apply:** After editing layout.tsx `<head>`, always `git diff` to verify the edit survived the formatter. For metadata like RSS links, prefer the Next.js `metadata` API (`alternates.types` in the metadata export) over manual `<link>` tags — but note that `alternates.types` only renders on pages that don't override `alternates` in their own metadata.
