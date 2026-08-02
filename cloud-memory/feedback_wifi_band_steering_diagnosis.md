---
name: wifi-band-steering-diagnosis
description: "Mac Studio packet loss/slow sessions — check Wi-Fi BAND first (2.4GHz steering), not processes; hourly network-watchdog self-heals"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 38676dee-98b1-4fb0-8b7c-f2a41adee884
  modified: 2026-08-02T19:10:49.952Z
---

2026-08-02 incident: 20% packet loss + WSJ unloadable. First response (killing an 11-day stuck collect-review-texts.js + contactsd) did NOT fix it. Root cause: eero band-steered the Mac Studio onto 2.4GHz (channel 7, 20MHz) — signal was excellent (-51 dBm) but capacity ~1/10 of 5GHz, so ~20 concurrent Claude sessions saturated the link. Fix: bounce Wi-Fi (`networksetup -setairportpower en1 off; ...on`) → rejoined 5GHz channel 36/80MHz → 0% loss.

**Why:** Load/process symptoms and network symptoms co-occur on this box (many agent sessions), so process cleanup looks like the fix but isn't. Band check is 5 seconds: `system_profiler SPAirPortDataType | grep Channel` — "2GHz" on en1 = the problem.

**How to apply:** On connectivity complaints, check band + `route -n get default` (Wi-Fi en1 vs Ethernet) BEFORE killing processes. `~/.claude/bin/network-watchdog.sh` (launchd `com.bsc.network-watchdog`, hourly) auto-bounces off 2.4GHz (max 1x/24h) and reaps >24h high-CPU node scripts + >1d headless Chrome; log at `~/.claude/logs/network-watchdog.log`. Durable fix the owner can make: plug in Ethernet (kills the whole class). Related: [[feedback_github_polling_rate_limit]]
