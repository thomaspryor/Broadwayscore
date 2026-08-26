---
name: feedback_git_trace_curl_diagnoses_push_hangs
description: GIT_TRACE_CURL (not GIT_TRACE/GIT_TRACE_PERFORMANCE) is the way to tell a genuinely-stalled git push from local pack-building slowness — use it before guessing a fix for a mysterious CI git push timeout. Also covers a distinct signature — api.github.com unreachable while github.com (git-over-HTTPS) works fine — seen in a headless/cloud sandbox.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 646f94c5-6245-4989-bcb9-8da3602f8f89
  modified: 2026-08-26T14:25:55.534Z
---

When a `git push` hangs for exactly a configured timeout with no other symptom, don't guess between "network stall" and "local computation slow" — instrument with `GIT_TRACE_CURL=1` (+ `GIT_TRACE_CURL_NO_DATA=1` to suppress the pack payload dump) and read where the trace goes silent. `GIT_TRACE`/`GIT_TRACE_PERFORMANCE` show git's internal phase timers but not HTTP/TLS transport detail, so they can't make this distinction.

**Why:** card #1810 (update-show-status.yml chronic 90s push hangs) was hypothesized as "shallow clone forces a large network transfer." A live diagnostic dispatch with `GIT_TRACE_CURL` showed the `info/refs` ref-advertisement GET completing in ~300ms on every attempt, then a *silent* 90s gap with zero curl trace lines (the pack POST request never even opened) before the timeout killed the process. That's the signature of LOCAL git computation (pack-building against an ambiguous shallow boundary) — not a stalled transfer. Guessing wrong here (e.g. going straight to raising the timeout, or enabling a network-bypass fallback) would have masked the real fix (`fetch-depth: 0` on the checkout) or done nothing at all.

**How to apply:** any time a CI `git push`/`git fetch` step hangs at exactly a configured `GIT_NET_TIMEOUT_SEC`-style wall with no useful stderr, before picking a fix: dispatch one instrumented run with `GIT_TRACE_CURL=1`/`GIT_TRACE_CURL_NO_DATA=1` added to that step's env, and look for the gap between the ref-advertisement response and the next curl `OPENED stream` line. A silent gap = local computation (shallow-boundary ambiguity, huge object enumeration, etc.); active-but-slow curl lines = a genuine transport problem (proceed to `http.lowSpeedLimit`/timeout tuning or investigate the network path instead).

**Second signature (headless/cloud worktree sessions, no CI involved):** `git push` over `https://github.com/...` hangs with NO timeout at all — not even the CI wall above — while `git ls-remote origin` (fetch direction) and plain `curl` to `api.github.com` both succeed instantly. This is the `osxkeychain` `credential.helper` blocking on a keychain prompt the headless session has no UI to answer (confirmed 2026-08-20, BRO-125 session: `git config --get credential.helper` → `osxkeychain`; `gh auth status` showed a valid token). Fix: bypass the credential helper for that one push with an explicit bearer header instead of debugging the hang —
```bash
git -c credential.helper= -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$(gh auth token)" | base64)" push ...
```
Don't burn time on `GIT_TRACE_CURL` for this signature — the trace won't even show a stalled HTTP request, since the hang is credential-helper-side, before curl opens the connection.
