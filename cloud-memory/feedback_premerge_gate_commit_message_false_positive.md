---
name: feedback_premerge_gate_commit_message_false_positive
description: "pre-merge-review-gate.sh can false-positive block ANY Bash command (git commit, linear-brain.js create --notes, etc.) whose quoted-string prose mentions \"git merge\"/\"into main\"-shaped phrases, not an actual command — reword the text rather than debug the gate."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3a94332d-0e73-4657-ad59-47ae5c4939e0
  modified: 2026-09-08T06:31:00.577Z
---

Hit 2026-08-15 (BRO-142 session): a plain `git commit -m "$(cat <<'EOF' ... EOF)"` was BLOCKED by `~/.claude/hooks/pre-merge-review-gate.sh` with "would put N unreviewed code lines on shared main", even though the actual Bash command was just a commit — no merge invocation anywhere.

**Why:** the gate's tokenizer (`parseMergeIngress` in `scripts/lib/review-gate.mjs`) doesn't distinguish literal shell command tokens from quoted-string/heredoc VALUES. Any Bash command whose text legitimately discusses merge-related infra work — naming the wrapper script `merge-worktree-to-main.sh`, or describing `git merge --abort`/"human's bare git merge into main" in prose/backticks — gets misclassified as an actual merge invocation, because the tokenizer splits the WHOLE command text (quoted strings and heredoc bodies included) on shell operators/newlines and matches on substrings anywhere in it.

**How to apply:** if a Bash command you know contains no real merge command gets blocked this way, don't fight the gate or add NO-SHIP-CHECK — just reword the text to avoid the literal trigger phrases (e.g. "the merge wrapper script" instead of the filename, avoid backtick-quoting `git merge --abort` verbatim, avoid "merge...into main" as a phrase pair). Not just `git commit -m` — hit again 2026-09-08 (BRO-3024 session) on a `node scripts/linear-brain.js create ... --notes "..."` call whose --notes prose described `.gitattributes`' merge-driver semantics (mentioning "git merge" and "main"); same tokenizer bug, different command. This is common for any commit or Linear-card text about push/merge infra work in this repo. A real fix is tracked as Notion/task #1557 ("pre-merge-review-gate.sh false-positives on commit messages whose PROSE mentions merge/git-merge") — check if it's landed before assuming this workaround is still needed.
