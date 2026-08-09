---
name: feedback-validate-data-local-self-heal
description: "node scripts/validate-data.js writes self-heal side effects (outlet-registry.json auto-registration, validation-baseline.json touch-up) even on a pure verification run — check git status and discard unrelated diffs before committing"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 178deca6-6c33-479d-add3-ba62ceb04409
  modified: 2026-08-09T12:00:29.833Z
---

Running `node scripts/validate-data.js` locally as a pure sanity check (no intent to commit anything) can still leave `data/outlet-registry.json` (auto-registers newly-seen outlets) and `data/audit/validation-baseline.json` modified in the working tree — these are self-heal side effects of the validator itself, not something you asked it to do.

**Why:** discovered while verifying a fix for [[project_reverse_discovery_cron_fix]] — ran `validate-data.js` twice on a branch that otherwise had zero intended diff, and `git status` came back dirty with these two files. They were unrelated to the fix and would have shipped stale/duplicate registry entries from an unrelated branch if committed blindly.

**How to apply:** after any local `validate-data.js` run, `git status` before committing or rebasing. If `data/outlet-registry.json` or `data/audit/validation-baseline.json` show up and weren't part of the intended change, `git checkout -- <file>` to discard them — they'll regenerate correctly from the real pipeline (CI's own validate-data.js run) rather than from an incidental local invocation.
