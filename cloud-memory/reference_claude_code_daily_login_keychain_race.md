---
name: reference-claude-code-daily-login-keychain-race
description: "Recurring daily \"401 socket closed / run /login\" on macOS = launchd jobs bypass zshrc and rotate the keychain OAuth grant; fix is static token in every caller"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 427b02f7-23e8-454b-863c-e689e584b3e9
---

Recurring ~daily forced `/login` in Claude Code on macOS (error: `401 The socket
connection was closed unexpectedly`) is almost never real auth loss. Root cause
found 2026-06-28: **background launchd jobs that invoke `claude` headless do not
source `~/.zshrc` and were never given a token**, so they authenticate via the
macOS **keychain** OAuth grant and rotate its single-use refresh token. Two jobs
(`com.bwsc.action-dispatcher`, `com.broadwayscore.claude-email-worker`, both
every 5 min) refreshing the same credential concurrently invalidate each other →
keychain credential dies ~once a day → 401 → `/login`. A token in `.zshrc` only
covers interactive terminals, never launchd — which is why that 2026-06-21 fix
didn't stick.

**Diagnosis order that worked:** (1) `claude doctor`, `date` (rule out clock).
(2) Test the token directly with curl `Authorization: Bearer` → 200 means the
credential is FINE and the "401" is a transport/keychain artifact, not expiry.
(3) `launchctl print gui/$(id -u)/<label>` + read the plists → find headless
`claude` callers with no `CLAUDE_CODE_OAUTH_TOKEN`. (4) keychain `mdat`
(`security find-generic-password -s "Claude Code-credentials" -a "$USER" -g`)
advancing every few min = active rotation = the smoking gun.

**Fix:** give EVERY caller the same long-lived `sk-ant-oat` token (direct bearer,
no rotation): canonical 600 file `~/.config/claude/token`; `.zshrc` sources it
(covers interactive + cmux panes, which ARE interactive shells); the token goes
in each launchd plist's `EnvironmentVariables` dict (they already have one for
PATH/HOME — matches the existing idiom, no new login-agent or global
`launchctl setenv`). Full setup + rollback + rotation runbook:
`~/.config/claude/README.md`; rotate via `~/.config/claude/update-token.sh`.

**Gotchas confirmed empirically:** `apiKeyHelper` does NOT work for an `sk-ant-oat`
token — it sends the value as `X-Api-Key` and the server rejects it ("Invalid API
key"); the env-var path is required. `CLAUDE_CODE_OAUTH_TOKEN` OVERRIDES a fresh
`/login` at runtime (binary string confirms it), so once this is set **`/login`
is a no-op** — recovery is re-mint + `update-token.sh`, not `/login`. `zsh -lc`
(login, non-interactive) does NOT source `.zshrc`; test the interactive path with
`zsh -ic`. Static tokens are inference-only (no Remote Control). macOS has an
internal `if(macos) delete CLAUDE_CODE_OAUTH_TOKEN` scrubber in the `--bg`
daemon-spawn path. Verdict-proof is keychain `mdat` freezing over ~48h, not a
single invocation (refresh is time-triggered, not per-call).
