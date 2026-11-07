---
name: mac-studio-tcp-tuning
description: Mac Studio has non-standard TCP sysctls + a TIME_WAIT monitor after the 2026-07-08 ephemeral port exhaustion incident
metadata: 
  node_type: memory
  type: reference
  originSessionId: 91499186-2b20-475b-9cd6-96d5f854c7d6
---

After the 2026-07-08 port-exhaustion incident (18.8k TIME_WAIT > 16,384-port pool, kernel TIME_WAIT reaper wedged — count frozen with zero processes alive, only reboot fixed it), the Mac Studio runs non-standard TCP config:

- `net.inet.ip.portrange.first=16384` (+hifirst), `net.inet.tcp.msl=5000` — applied at boot by `/Library/LaunchDaemons/com.tompryor.tcp-tuning.plist`. **`portrange.first` is the knob that matters on macOS — default connect() ignores hifirst/hilast.**
- TIME_WAIT monitor: LaunchAgent `com.tompryor.timewait-monitor` runs `~/.claude/tools/timewait-monitor.sh` every 60s. Log: `~/Library/Logs/timewait-monitor/monitor.log`. On >60% pool it saves a `netstat -anv` forensic dump (has process:pid — lsof cannot attribute TIME_WAIT). Wedge signature = count >2000 AND frozen 3 samples → alert says sysdiagnose + reboot (sysctls cannot fix a wedged reaper).
- Full breadcrumb + revert commands: `~/Documents/claude-outputs/tcp-tuning-breadcrumb.md`.
- Root-cause finding: NOT a Claude Code retry storm. Measured healthy churn is ~4 conns/90s to api.anthropic.com across 31 claude processes (keep-alive works). 12k TIME_WAIT = days of slow accumulation while the kernel reaper was wedged. No auto-session-reaper installed — idle sessions aren't the generator.
