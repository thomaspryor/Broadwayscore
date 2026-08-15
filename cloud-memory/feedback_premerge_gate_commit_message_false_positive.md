---
name: feedback_premerge_gate_commit_message_false_positive
description: "pre-merge-review-gate.sh can false-positive block a plain `git commit` when the commit MESSAGE prose mentions \"merge-worktree-to-main.sh\" or \"git merge --abort\" as text, not an actual command — reword the message rather than debug the gate."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3a94332d-0e73-4657-ad59-47ae5c4939e0
  modified: 2026-08-15T03:20:26.618Z
---

Hit 2026-08-15 (BRO-142 session): a plain `git commit -m "$(cat <<'EOF' ... EOF)"` was BLOCKED by `~/.claude/hooks/pre-merge-review-gate.sh` with "would put N unreviewed code lines on shared main", even though the actual Bash command was just a commit — no merge invocation anywhere.

**Why:** the gate's tokenizer (`parseMergeIngress` in `scripts/lib/review-gate.mjs`) doesn't distinguish literal shell command tokens from quoted-string/heredoc VALUES. A commit message that legitimately discusses merge-related infra work — naming the wrapper script `merge-worktree-to-main.sh`, or describing `git merge --abort` in prose/backticks — gets misclassified as an actual merge invocation, because the tokenizer splits the WHOLE command text (heredoc body included) on shell operators/newlines and matches on substrings anywhere in it.

**How to apply:** if a `git commit` you know contains no real merge command gets blocked this way, don't fight the gate or add NO-SHIP-CHECK — just reword the commit message to avoid the literal trigger phrases (e.g. "the merge wrapper script" instead of the filename, avoid backtick-quoting `git merge --abort` verbatim). This is common for any commit about push/merge infra work in this repo. A real fix is tracked as Notion/task #1557 ("pre-merge-review-gate.sh false-positives on commit messages whose PROSE mentions merge/git-merge") — check if it's landed before assuming this workaround is still needed.
