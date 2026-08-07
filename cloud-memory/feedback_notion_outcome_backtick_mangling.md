---
name: feedback-notion-outcome-backtick-mangling
description: bash backticks inside a double-quoted --outcome string silently mangle notion-brain.js writes — write outcome text to a file first
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1b58a0dd-d398-4008-86fe-789fa08e3678
  modified: 2026-08-07T11:56:04.132Z
---

Never pass `--outcome "...text with \`inline code\`..."` as a literal double-quoted bash argument. Backticks inside double quotes trigger bash command substitution — `` `const start = show.openingDate || ...` `` gets executed as a shell command (fails silently, "command not found"), and the surrounding text is dropped or mangled. The `notion-brain.js update` call still exits 0 and updates other fields (status, completedDate), so nothing looks wrong — the outcome text is just silently truncated/garbled in the live Notion card.

**Why:** hit this live on 2026-08-07 (task #1121) — an outcome update citing `` `const start = show.openingDate || show.previewsStartDate || null` `` vanished from the card entirely; only caught by re-fetching the card and grepping for the expected text.

**How to apply:** whenever writing a Notion `--notes`/`--outcome` value that contains inline code, file paths with special chars, or any backtick-quoted snippet, write the text to a temp file first (`cat > /tmp/notion-outcomes/X.txt << 'EOF' ... EOF`, using a **quoted** heredoc delimiter so nothing inside expands) and pass it via `--outcome "$(cat /tmp/notion-outcomes/X.txt)"`. The command substitution here is safe — it captures the file's literal bytes without re-parsing them as shell syntax. After any Notion write with non-trivial text, re-fetch the card (`notion-brain.js get <id>`) and grep for a distinctive phrase to confirm it actually landed, rather than trusting exit 0.
