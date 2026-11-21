---
name: Vercel preview env var add needs TTY or CLI ≥52
description: vercel env add NAME preview --value V --yes fails on CLI 50.x with "git_branch_required" even though the CLI's own hint suggests that exact command. Either upgrade vercel@latest globally, or wrap the call in `expect` to satisfy the interactive prompt.
type: feedback
originSessionId: d02b062b-53e1-40c2-b795-7fd233158fb5
archived: true
---
`vercel env add NAME preview --value V --yes` on Vercel CLI 50.35.0 fails with `git_branch_required` despite the CLI's machine-readable hint suggesting that exact command. The `--value` and `--yes` flags ARE accepted, but the parser still wants a git-branch positional or interactive selection.

**Workarounds (in order of cleanliness):**

1. **Upgrade the CLI:** `npm i -g vercel@latest` (was 50.35.0, latest 52.0.0 as of 2026-04-25). Note: even on 52.0.0, the same prompt may appear in non-interactive mode — fall back to #2.

2. **Wrap in expect for TTY:**
   ```bash
   expect -c "
     set timeout 30
     spawn vercel env add KEY preview --value {VALUE} --yes
     expect {
       \"Git branch\" { send \"\r\"; exp_continue }
       eof
     }
   "
   ```
   Sending Enter ("\r") on the "Git branch" prompt selects "all Preview branches".

3. **Vercel REST API:** the auth token at `~/Library/Application Support/com.vercel.cli/auth.json` is NOT a Bearer token — REST calls return `invalidToken`. To use the REST API you'd need a real Vercel API token from vercel.com/account/tokens.

**How to apply:** When adding env vars across all 3 Vercel environments (Production / Preview / Development), Production and Development go through normal `vercel env add` cleanly. Preview needs the expect wrapper or the user manually adds it via the dashboard.

References:
- Discovery: PR #281 session 2026-04-25
- Working expect script: see Bash invocation in conversation
