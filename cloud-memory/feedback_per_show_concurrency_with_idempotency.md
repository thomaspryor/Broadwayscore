---
name: Per-show concurrency needs the watcher idempotency check
description: opening-night-poller's per-show concurrency group is intentionally paired with watcher idempotency. Don't drop one without dropping the other.
type: feedback
originSessionId: 069a09d8-0f38-4e51-ae36-f2f514c1f6e4
archived: true
---
opening-night-poller.yml uses `group: opening-night-poller-${{ inputs.show_id || github.run_id }}` (Tonight #7 fix, 2026-04-26 commit 278ecdd9aa). The form looks like Cats 2026-04-07's broken shared group, but it's not — when `show_id` is empty (auto-discovery dispatch) the group falls back to per-run unique. Only same-show targeted dispatches share a group.

**Why:** Backstop for the Joe Turner 2026-04-25 push race (3 watcher ticks + 1 orchestrator dispatch all hitting the same show, exhausting push retries and triggering HTTP 403 install rate-limit on rebuild dispatch). The primary fix is the watcher's `pollerInFlightForShow()` idempotency check in `scripts/watch-aggregator-urls.js`; the group is the safety net.

**How to apply:**
- If you remove the watcher idempotency check (or the lib at `scripts/lib/poller-idempotency.js`), the group becomes lossy: 3+ same-show dispatches → GitHub queue-depth-1 cancels the third. Remove only if you're sure same-show triple-dispatch can't happen.
- If you remove the per-show group, watcher idempotency still blocks watcher-vs-watcher and watcher-vs-orchestrator races. But manual `gh workflow run` from Claude/Tom can still race against an in-flight poller. Keep the group.
- Detection contract: poller has `run-name: Opening Night Poller — ${{ inputs.show_id || 'auto' }}`. The watcher matches by `displayTitle.endsWith('— ${showId}')` (em dash + space + slug, suffix-anchored to avoid `the-bear-2025` false-matching `the-bear-bites-back-2025`). If you change run-name, update `scripts/lib/poller-idempotency.js` and the unit tests together.
- **Auto-coverage rule (added 2026-04-26 via /ship-check):** an in-flight `Opening Night Poller — auto` run iterates ALL today's openings inside opening-night-poller.js — `findInFlightPollerForShow` MUST treat such a run as covering any show. Without this, `update-show-status.yml:943` and the orchestrator's multi-show branch (which both dispatch with no show_id → run-name suffix `— auto`) still race against the watcher's targeted dispatches. This is the same Joe Turner push storm at a different lane. If you ever convert auto dispatches to per-show fan-outs, you can drop the auto fallback — but until then, keep it.
- **Active-status set (Codex finding 2026-04-26):** `isActiveStatus` covers `in_progress|queued|waiting|pending|requested`. GitHub transitions runs through waiting/pending/requested before in_progress; `deploy-on-data-change.yml:144` already treats `waiting` as active. Don't narrow this back to `in_progress|queued`.
