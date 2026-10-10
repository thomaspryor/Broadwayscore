---
name: test-impure-git-checkout-function-guard
description: "Guard tests that require() and call a real function performing git ops on a nested private-repo checkout (data/review-texts, data/aggregator-archive) — check the checkout exists before calling past the point it would mutate it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9e77c8c2-0ceb-4398-80a0-4bac51e84689
  modified: 2026-09-16T08:45:35.778Z
---

When a test needs to exercise the impure wrapper itself (not just the pure decision logic extracted per [[feedback_test_extraction_pattern]]) — e.g. `pushReviewTextsCheckpoint()`, which does `git add -A` / commit / push inside `data/review-texts` relative to `process.cwd()` — guard the test with an existence check for that nested checkout (`fs.existsSync(path.join(process.cwd(), 'data', 'review-texts', '.git'))`) before calling the real function past the point where it would start mutating it. Skip (`t.skip(...)`) rather than assert if a real checkout is present.

**Why:** Caught by Codex during BRO-2381's ship-check. A test called the real `pushReviewTextsCheckpoint()` with a fake token to verify it proceeds past an env-var gate. In this sandboxed/cloud worktree there's no real `data/review-texts` checkout so it was safe, but on a dev machine that has actually cloned that private repo locally (some sessions do, for local testing), the same test would reconfigure its git identity/remote to a fake token and `git add -A` + commit whatever was staged there — including real uncommitted work — before the push predictably fails on the fake credential. The commit would already have happened by then.

**How to apply:** Any test file that `require()`s a script with a similar impure git-checkout wrapper (this repo has several: `data/review-texts`, `data/aggregator-archive`, `data/core-data-checkout`) and calls it directly rather than just the extracted pure gate function, add the existence guard first. The pure-function tests (testing the extracted decision logic in isolation) don't need this — only tests that call through to the real git-mutating function.
