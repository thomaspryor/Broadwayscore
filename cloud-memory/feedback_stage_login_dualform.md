---
name: The Stage login has dual forms — OBSOLETE, now cookie-only
description: "Historical; login code removed 2026-03-30. See stage_cookie_only."
type: feedback
archived: true
---

**OBSOLETE as of 2026-03-30.** All Stage email/password login code has been removed. Auth is now cookie-only via cookie-loader.js. See `feedback_stage_cookie_only.md`.

Historical context (kept in case login code is ever needed again): The Stage /login page has two forms (main + nav). Use `$$()` + `isVisible()` loop, never `$()`. Roundup/listing pages have no login form.
