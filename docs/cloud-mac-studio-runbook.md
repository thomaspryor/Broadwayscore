# Running work on the owner's Mac Studio from a cloud session (BRO-8014)

Cloud sessions can start a Claude session ON the Mac Studio. Do it yourself; never ask the owner to open a local session or run a command.
1. `list_environments`: the Mac shows as `kind: bridge` environments named `Toms-Mac-Studio:<folder>:<id>` (folders `Broadwayscore`, `BroadwayScorecard-app`, `tmp`). Pick the one for the repo. `list_computer_folders` reports these folders `not_available` to cloud sessions: that only means you can't attach the folder here, starting a session there still works.
2. `create_session` with that `environment_id`, a `model` from `node scripts/session-model.js BRO-N`, and a self-contained prompt (card, steps, what to verify, `send_message` the result to your session id from `get_session`).
3. First time in a session it is refused with `elevated_session_untrusted_device`: call `confirm_repository_trust` with the digest the refusal gives. The owner taps yes on their phone (no chat question first), then repeat the same `create_session`.
4. The Mac must be online (green dot under Devices in the app). If no bridge environment is listed or the session never connects, say so in one line and continue the rest from cloud.
Prompt the Mac session to avoid anything needing the Mac password (sudo) and never to ask the owner to type commands. Example: the self-hosted E2E runner setup, started from the GitHub-billing session on 2026-11-21.
