---
name: Unit tests must use Node native test format, not Jest
description: Tests in this project use node:test (.mjs) not Jest — Jest is not installed
type: feedback
originSessionId: f075b39c-5209-433b-968f-4c9c8f138cf2
---
This project has no Jest or Vitest installed. All unit tests must use the native `node:test` API in `.mjs` files.

**Why:** Card #4+#5 session wrote `verify-fetched-url.test.js` and `review-write-guard.test.js` using Jest `describe`/`test` API. These ran as a single failing test with `ReferenceError: describe is not defined` and were never registered in CI — they were silently dead. Caught in QA review (2026-04-18).

**How to apply:**
- Always use `.mjs` extension for unit tests
- Use `import { test, describe } from 'node:test'` and `import assert from 'node:assert/strict'`
- Register new test files explicitly in `.github/workflows/test.yml` unit-tests step
- The `node --test` runner does NOT support `describe`/`expect`/`beforeEach` without `node:test` imports
- Check the existing clear-failure-flags.test.mjs for the correct format pattern
