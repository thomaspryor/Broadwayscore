---
name: reference-claude-code-daily-login-keychain-race
description: "Recurring daily 401 / forced /login on macOS: keychain credential BEATS CLAUDE_CODE_OAUTH_TOKEN (env token is only a fallback) — fix is DELETE the keychain entry so everything uses the static token; never /login casually"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 427b02f7-23e8-454b-863c-e689e584b3e9
  modified: 2026-09-24T23:52:35.258Z
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
no rotation): canonical 600 file `~/.config/claude/token`; **`~/.zshenv` sources
it** (corrected 2026-07-14: `.zshrc` was WRONG — cmux spawns claude via `zsh -l`
login NON-interactive, which skips `.zshrc`; `.zshenv` is sourced by every zsh);
the token goes in each launchd plist's `EnvironmentVariables` dict — the full
list lives in `update-token.sh`'s PLISTS array (4 jobs as of 2026-07-14). Full
setup + rollback + rotation runbook: `~/.config/claude/README.md`; rotate via
`~/.config/claude/update-token.sh`.

**2026-07-15 CORRECTION — the env-token architecture was built on a false premise.**
Empirical tests (isolated CLAUDE_CONFIG_DIR, valid/invalid tokens, binaries
2.1.209 + 2.1.210): macOS precedence is **keychain FIRST; CLAUDE_CODE_OAUTH_TOKEN
is only a fallback when no keychain credential exists**. "Env token overrides
/login" was inferred from a binary string, never tested — WRONG. Coverage work
(zshenv, plists) therefore never stopped rotation. Real fix: DELETE the
"Claude Code-credentials" keychain entry (`purge-keychain-login.sh`) so every
caller falls back to the static token. /login recreates the entry and re-poisons
ALL sessions — restart a prompting session instead; check-token.sh emails if the
entry reappears. Test method that settled it: invalid env token + keychain
present → works (keychain used); isolated config + valid token → works; isolated
config + invalid token → 401. Lesson: auth-precedence claims need a
disprove-test (deliberately invalid credential), not a binary-strings read.

**Recurrence pattern (2026-07-14):** the race came back 2 weeks after the fix
because NEW headless claude callers were installed tokenless (autonomous-nightly
2026-07-13, weekly-retro) + the cmux `.zshrc` gap above. Any ONE tokenless
caller restarts keychain rotation and kills every keychain-path session daily.
Prevention now encoded: `check-token.sh` (daily 09:30 launchd) audits all
LaunchAgents for claude-invoking scripts whose plist lacks the token and
macOS-notifies. When installing any new launchd job that runs claude: add its
plist to PLISTS in update-token.sh and rerun it with the current token.

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

**2026-09-24 recurrence — cmux update correlation, unconfirmed mechanism.** The
sentinel log was clean (zero purges, daily "OK" only) 2026-08-17→2026-09-20, then
flipped to clustered `SENTINEL auto-purged` events: Sep 20 (21:56, 22:01), Sep 22
(3x within 15 min), Sep 24 (19:26, 19:46). Correlates with cmux.app auto-updating
locally to v0.64.25 on Sep 20 21:25 (cmux-claude-wrapper mtime Sep 17), and with
cmux's own fresh GitHub issue #14308 ("0.64.25 Agent hibernation almost never
applies to Claude Code: idle_prompt marks finished chats needsInput", filed
2026-09-24, manaflow-ai/cmux — public repo). Hypothesis (cmux's new
agent-hibernation wake path spawns/reactivates some sessions via a path that
skips `.zshenv`, so those hit no-keychain+no-token → interactive `/login` prompt,
purged within the sentinel's 5-min cycle) is **PLAUSIBLE BUT NOT CONFIRMED** —
/second-opinion review flagged it as correlation not causation (roster.json
touched 7min *before* the app bundle's own mtime, more consistent with an
installer writing state than a live wake event). Direct check of ~15 live
`claude` processes' env (`ps eww -p <pid> | grep CLAUDE_CODE_OAUTH_TOKEN`) found
the static token present in every one, including this session's own PID —
undercuts the "spawn skips .zshenv" mechanism for anything currently running
(env is fixed at exec time; if present now it was present at launch). Mitigation
applied as a free/reversible test: `cmux agent-hibernation off` (2026-09-24;
cmux CLI subcommand exists and takes `on|off [--json]`). If purge clusters stop
after this, hibernation was the driver; if they continue, look elsewhere
(the reviewer's alternate theory: cmux changing pane shell-spawn mode
login-vs-non-login on update, independent of any "hibernation" feature — also
unconfirmed). Re-enable via `cmux agent-hibernation on` if this doesn't help
and hibernation is wanted back. Either way: **this is a cosmetic/nuisance
flicker, not architecture failure** — the sentinel does its job within
5-15 min every time observed; nothing here indicates the June-July fix regressed.

**2026-09-24 — never run `security find-generic-password -g` (or `-w`) near a
transcript.** Confirming the keychain entry's *existence* (`security
find-generic-password -s "Claude Code-credentials"`, no `-g`/`-w`) is safe — it
was used throughout this diagnosis without incident. Adding `-g`/`-w` prints the
actual password/secret to stdout and is the same class of violation as `cat`ing
a credential file even though it isn't literally `cat`. Session incident: this
flag was added out of habit while pivoting from "does it exist" to "what's in
it", printing a live OAuth access+refresh token into the transcript. Recovery
was `claude auth logout` (revokes + deletes the keychain entry — actually the
architecturally-correct end state per the sentinel design above) immediately
after. **Never add `-g`/`-w` to a `find-generic-password` call, ever, for any
reason** — if the value is genuinely needed, there is no safe way to get it
into a Claude Code transcript at all; the task needs to be done by the user in
their own terminal instead.
