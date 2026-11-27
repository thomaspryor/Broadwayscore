# What still runs on the owner's Mac (BRO-7554, 2026-11-15)

Owner question: "Are there other things on the Mac that stall or error that we should move to the cloud?"
Every launchd job in `scripts/launchd/` must appear below with a verdict (`scripts/tests/mac-routed-work-inventory.test.mjs` fails otherwise). Add a row when you add a plist.

Verdicts: **moved** (now a GitHub Actions cron, plist deleted), **needs-Mac** (cookies, keychain, local-only files, the Mac's own health) or **cloud-capable** (only talks to GitHub, Linear or an API; a GitHub Actions cron or a cloud routine can run it). "Move" notes name the cheapest route.

## Card work (the path that stalled)

| Path | Verdict | Why |
|---|---|---|
| `linear-next.js --id` default headless job (`bsc-runner`) | cloud-capable | 103 cards in 30 days carried a headless "Dispatched" comment, none labelled `mac-only`. The job posts that comment after it ends, moves no state and leaves nothing watching it. Now: refused from a cloud container; a silent one is requeued to Todo for a cloud worker (`silent-dispatch-sweep`, hourly). |
| Cards filed `--mac-only` (drained by `linear-drain-parked`) | needs-Mac | Cards that need the Mac's cookies, keychain or local files. The cloud picker skips them by design. |
| `dispatch-watchdog.js` re-dispatch | cloud-capable | Re-runs Mac headless jobs. Covered by the same silent-dispatch requeue; the BRO-5626 retirement of the Mac fleet finishes the move. |

## launchd jobs

| Job | Verdict | Why |
|---|---|---|
| com.broadwayscore.autonomous-shadow | cloud-capable | Shadow run of the retired loop; plist says retire on the owner's decision. |
| com.broadwayscore.checkout-sync | needs-Mac | Keeps this Mac's checkout fresh. |
| com.broadwayscore.session-llm-usage-push | needs-Mac | Pushes this Mac's reviewer-spend rows (home file under ~/.claude/state) to main (BRO-8356). |
| com.broadwayscore.claude-auth-health | needs-Mac | Probes the Mac's own Claude OAuth token. |
| com.broadwayscore.cmux-auth-stall-watchdog | needs-Mac | Reads local cmux tabs. |
| com.broadwayscore.cmux-reachability | needs-Mac | Probes the local cmux socket. |
| com.broadwayscore.cookie-renew | needs-Mac | Renews paywall cookies from the Mac's browser profile. |
| com.broadwayscore.deploy-heartbeat | needs-Mac | A backup trigger that must NOT depend on GitHub's cron (that is its job). |
| com.broadwayscore.dispatch-watchdog-health | needs-Mac | Reads the Mac dispatch ledger (gitignored, per machine). Goes when the Mac dispatch path does. |
| com.broadwayscore.gap-recovery-nightly | needs-Mac | NYT subscriber text recovery uses the Mac's logged-in browser. |
| com.broadwayscore.gap-recovery-opening-window | needs-Mac | Same recovery, every 20 min in opening windows. |
| com.broadwayscore.job-memory-cap | needs-Mac | Kills a runaway local worker's process tree (BRO-8175). Goes when the Mac dispatch path does. |
| com.broadwayscore.hook-liveness | needs-Mac | Checks `~/.claude/hooks` on this Mac. |
| com.broadwayscore.infra-gate-registration | needs-Mac | Checks `~/.claude` registration on this Mac. |
| com.broadwayscore.linear-drain-parked | needs-Mac | Drains `mac-only` cards; the cloud twin `linear-unpark-drain.js` takes the rest. |
| com.broadwayscore.mac-stall-sweep | needs-Mac | Reads this Mac's live sessions; the cloud sweeps cover everything else. |
| com.broadwayscore.morning-digest | needs-Mac | Reads local gitignored digest snapshots. |
| com.broadwayscore.newsletter-sunday-review | cloud-capable | One headless Claude pass with an API key; a cloud routine can run it. |
| com.broadwayscore.pr-supervisor | needs-Mac | Reads GitHub only, but its only consumer is the Mac morning digest (`~/.cyrus/pr-supervisor-status.json`); a runner copy is discarded and lacks the gitignored review-verdicts evidence (BRO-7573 review). Moves only together with the digest. |
| com.broadwayscore.predispatch-queue-audit | needs-Mac | Reads the Mac task mirror; moot once the Mac dispatch path is gone. |
| com.broadwayscore.reconcile-dead-completions | needs-Mac | Reads the Mac dispatch ledger. |
| com.broadwayscore.worktree-gc | needs-Mac | Cleans this Mac's disk. |
| com.broadwayscore.worktree-gc-freshness | needs-Mac | Deadman for the job above. |
| com.broadwayscore.wsj-cookie-refresh | needs-Mac | Mac Safari and email OTP login. |
| com.broadwayscore.xcode-toolchain | needs-Mac | This machine's Xcode state. |
| com.bwsc.opening-night-backup-trigger-we | needs-Mac | Backup that must not depend on GitHub's cron. |
| com.bwsc.opening-night-backup-trigger | needs-Mac | Same backup, US shows. |
| com.bwsc.opening-night-monitor | cloud-capable | A bounded headless Claude pass every 20 min; a cloud routine can run it (needs its own card and a watch plan, not moved here). |

Not moved (BRO-7573): `pr-supervisor` (output only the Mac digest reads), `linear-delegation-check` (retired 2026-10-25 in `config/mac-retired.json`; plist deleted, never recreate), `newsletter-sunday-review` and `opening-night-monitor` (headless Claude sessions that merge code and read Mac state; each needs its own card and watch plan). `autonomous-shadow` stays until the owner confirms retirement; `autonomous-deadman` and `autonomous-nightly` were deleted (loop retired 2026-07-27).
