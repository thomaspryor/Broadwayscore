---
name: feedback_codex_tmp_reverify_same_call
description: "ship-check's Codex step: never re-derive $CODEX_OUT via ls -t /tmp/codex-review-output.* in a later Bash call — grabs a concurrent session's file instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31baca8b-64d7-467e-9e67-bc2398b153d6
  modified: 2026-08-19T16:27:32.229Z
---

`/ship-check`'s Codex adversarial-review step correctly uses a per-run
`mktemp /tmp/codex-review-output.XXXXXX` and captures it in `$CODEX_OUT`
within the same shell invocation — that part is safe. The mistake is what
happens *after*: Bash tool shell state does not persist across separate
Bash calls, so a later call has no `$CODEX_OUT` anymore. Reaching for
`ls -t /tmp/codex-review-output.* | head -1` to re-find "the" file is wrong
on this machine — it runs 20+ concurrent Broadwayscore sessions, each
capable of writing its own same-prefixed temp file at any moment, and `ls -t`
just returns whichever is newest, which can belong to a different session
entirely (reproduced 2026-08-19 on task #1826's ship-check: grabbed another
session's in-flight review of an unrelated worktree, read its content as if
it were mine, and burned real time and tokens trying to make sense of it).

**Why this matters:** same failure class as `feedback_second_opinion_tmp_collision.md`
(that one covers `/second-opinion`'s fixed `/tmp/check-plan.txt`; this one is
the same shared-`/tmp` hazard hitting ship-check's *own* correctly-randomized
path, purely because the re-check happened in a separate tool call).

**How to apply:** if a later Bash call needs the Codex output again (e.g. to
extract findings after the main capture command already printed a truncated
preview), grep the exact persisted-output file path the harness printed for
*that specific tool call* (`.../tool-results/<id>.txt`), not a fresh `/tmp`
glob. Or better: do all reading/parsing of `$CODEX_OUT` inside the same Bash
invocation that set it, before the call returns.
