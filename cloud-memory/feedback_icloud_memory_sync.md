---
name: iCloud memory sync setup
description: "Mac Studio uses cron rsync; symlinks sandbox-blocked. MacBook symlinks fine."
type: feedback
originSessionId: 80658010-a992-4bf3-914f-182d1b407b16
archived: true
---
Claude Code's sandbox blocks access to `~/Library/Mobile Documents/` (iCloud Drive) regardless of FDA settings. Symlinks to iCloud paths fail with "Operation not permitted."

**Mac Studio setup (cron-based):**
- Local `memory/` folder (not a symlink)
- Cron job every 5 min: `rsync -au` local↔iCloud bidirectional
- Cron runs under user context with Terminal FDA, so it can access iCloud
- Launchd agents and Claude Code processes CANNOT access iCloud directly

**MacBook setup (symlink-based):**
- `memory/` is a symlink → iCloud `claude-memory/Broadwayscore/`
- Works because MacBook's Claude Code can read through the symlink (different sandbox/FDA config)

**Why:** FDA grants to `node`, `claude`, `rsync` don't help — Claude Code's sandbox is independent of macOS FDA.

**How to apply:** Never try to symlink memory to iCloud on Mac Studio. If the cron breaks, the fix is `crontab -e` in Terminal, not launchd. If a new Mac is added, test whether Claude Code can read through an iCloud symlink before choosing the approach.
