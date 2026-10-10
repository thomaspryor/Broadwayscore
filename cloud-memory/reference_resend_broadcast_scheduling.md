---
name: resend-broadcast-scheduling
description: "Resend dashboard has NO schedule option for broadcasts (only slide-to-send); scheduling exists solely via API scheduled_at on the send call, which rule-17 hooks block without explicit per-turn user authorization"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 78ee58f2-249b-467c-adaa-d14207056a6d
  modified: 2026-07-20T00:44:56.707Z
---

Resend broadcast scheduling (learned 2026-07-19, weekly-roundup send night):

- The Resend dashboard's broadcast send flow is a "Ready to send?" panel with **slide-to-send only** — there is no Schedule button for broadcasts. Do not tell the user to look for one (I did; they screenshotted the panel to correct me).
- Scheduling exists **only via the API**: `POST /broadcasts/{id}/send` with `scheduled_at` (ISO 8601 or natural language like "in 8 hours").
- That is the SEND endpoint — [[email-broadcast-rules]] / CLAUDE.md rule 17 apply. The pre-tool hook blocks it unless the same shell command carries `# BROADCAST_AUTHORIZED_BY=tom` after the user explicitly authorized THAT send in the current turn.

**How to apply:** if the user wants a morning send and doesn't want to be awake for it, the options are (a) explicit one-off authorization for an API `scheduled_at` send, or (b) they slide-to-send manually; there is no dashboard middle ground. Related: [[newsletter-refresh-fast-lane]] — scripts/newsletter/refresh-drafts.sh refreshes both drafts locally in ~2 min right before any send.
