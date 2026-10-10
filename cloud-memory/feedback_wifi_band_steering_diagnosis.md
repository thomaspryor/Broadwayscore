---
name: wifi-band-steering-diagnosis
description: Mac Studio slow/buggy sessions — TWO Wi-Fi causes (SSID hopping between home networks + 2.4GHz band steering); check these before killing processes
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 38676dee-98b1-4fb0-8b7c-f2a41adee884
  modified: 2026-08-02T22:57:10.358Z
---

2026-08-02 incident, three-layer root cause (process cleanup did NOT fix it):
1. **2.4GHz band steering** — Mac stuck on 2.4GHz ch7 despite -51 dBm signal; ~20 sessions saturated it → 20% packet loss. Fixed by Wi-Fi bounce → 5GHz.
2. **Multi-SSID hopping** — Mac had 3 home networks saved (Friend Fondue / Fixture / 2 + Slytherin Common Room) on DIFFERENT subnets (192.168.4.x eero vs 192.168.50.x ASUS). Each hop = new IP = every open TCP connection killed = "sessions can't connect". Fixed 2026-08-02: pinned to **Friend Fondue Fixture** — the dedicated 5GHz SSID the owner created just for the Mac Studio (owner calls it "Fixed"); ALL other home SSIDs incl. main "Friend Fondue" removed from auto-join (`networksetup -removepreferredwirelessnetwork`). Wi-Fi password retrievable via `security find-generic-password -D "AirPort network password" -a "<SSID>" -w`. NOTE: mid-diagnosis the subnet/gateway CHANGED (192.168.4.136→192.168.50.60) — always re-check `route -n get default` + `ipconfig getifaddr en1` before trusting earlier readings.
3. **DNS via router resolver** — 1.7s/lookup. Fixed: static 1.1.1.1/8.8.8.8 on the Wi-Fi service (survives network changes; revert: `networksetup -setdnsservers "Wi-Fi" Empty`).

**Why:** Load/process symptoms co-occur with network symptoms on this box, so process cleanup looks like the fix but isn't. A wrong double-NAT inference came from mixing readings taken on different networks.

**How to apply:** On connectivity complaints: (a) `system_profiler SPAirPortDataType | grep Channel` — "2GHz" = problem; (b) confirm gateway/IP haven't changed mid-session; (c) `traceroute -m 4` to verify topology instead of inferring. `~/.claude/bin/network-watchdog.sh` (launchd `com.bsc.network-watchdog`, hourly) auto-bounces off 2.4GHz (1x/24h) + reaps >24h high-CPU node scripts and >1d headless Chrome; log `~/.claude/logs/network-watchdog.log`. Durable owner fix: Ethernet cable. Related: [[feedback_github_polling_rate_limit]]
