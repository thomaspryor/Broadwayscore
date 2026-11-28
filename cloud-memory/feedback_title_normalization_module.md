---
name: Title normalization shared module
description: All scripts searching external sites by show title must use cleanSearchTitle() from scripts/lib/title-normalization.js
type: feedback
archived: true
---

All scripts that build search URLs from show titles must use `cleanSearchTitle()` from `scripts/lib/title-normalization.js`. Never inline title cleaning.

**Why:** 16 scripts had divergent/incomplete title cleaning. Shows with venue suffixes ("- Globe"), format suffixes ("the Musical"), &, curly quotes, or parenthetical qualifiers returned zero results from external APIs. Globe shows alone gained 34 reviews after the fix.

**How to apply:** When writing a new script that does `encodeURIComponent(showTitle)` for a search URL, add `const { cleanSearchTitle } = require('./lib/title-normalization')` and wrap the title first. Also use `titlesMatch(a, b)` for comparing titles from different sources. The `at the` stripping uses a hardcoded venue list (AT_THE_VENUES) that needs updating when new WE theaters open.
