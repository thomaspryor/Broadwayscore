---
name: content-survival-selftest-false-alarm
description: push-content-survival.js's own unit self-test prints "[content-survival] FAILED — silently REVERTED" using synthetic fixture commit hashes — don't mistake it for evidence of a real revert
metadata:
  type: feedback
  originSessionId: c6aa2312-568c-4365-8f97-c6bcb9539334
  modified: 2026-08-03T15:33:18.727Z
---

CI log lines reading `[content-survival] FAILED — 1 file(s) silently REVERTED to pre-edit content on <hash>` are NOT always evidence a real commit's content was reverted. `push-content-survival.js`'s own unit test (in the same Unit Tests job) deliberately triggers this exact message using synthetic/fabricated commit hashes to prove the detector's message format works (`PASS[2b]: new push-content-survival.js CATCHES the exact task #619 signature`). The surrounding context — `PASS[2b]`, `PASS[3]`, "✓ content-survival check actually ran (not silently skipped)" nearby in the same log — marks it as a self-test, not a real incident.

**Why:** a Notion card (#941) cited these exact log lines as proof that `validate-data.js`'s push-refusal sentinel implementation had been reverted by a parallel-session race. Investigating, the actual cause was unrelated: the sentinel unit test runs the *real* `validate-data.js` against the *real* committed `shows.json`/`reviews.json` and expects exit 0 on "clean" data — it was failing only because the corpus had a genuine, unrelated duplicate-URL bug (a `duplicateOf` cycle) that made "clean" data not actually clean. The sentinel code itself was never touched.

**How to apply:** before citing a `[content-survival] FAILED ... REVERTED on <hash>` log line as evidence of a real revert, `git cat-file -t <hash>` in the actual repo — if the hash doesn't exist (synthetic fixture) or the surrounding log lines say `PASS[2b]`/`PASS[3]`, it's the self-test, not a real incident. For sentinel/gate tests that shell out to the real production script against real committed data (pattern: `execFileSync('node', [VALIDATE], ...)` against `data/shows.json` in `tests/unit/validate-data-push-refusal-sentinel.test.mjs`), a failure means the REAL DATA currently has a real validation error — check `node scripts/validate-data.js` output directly before assuming the tested CODE regressed. See [[feedback_verify_bug_claim_before_fixing]].
