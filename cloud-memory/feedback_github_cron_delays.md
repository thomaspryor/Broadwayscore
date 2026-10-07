---
name: GitHub Actions cron delays are consistent and predictable
description: GHA crons fire 30min-3h late depending on hour; shift crons earlier to compensate; use local launchd as backup
type: feedback
originSessionId: 1ca7d6fd-fdf5-4664-9d80-02192bffb91b
---
GitHub Actions cron delays are consistent, not random. Measured across 30 orchestrator runs (April 2-9, 2026):
- 1 AM UTC: DROPPED entirely (never fires)
- 2:30 AM UTC: fires ~4 AM UTC (1.5h late)
- 7 AM UTC: fires ~8:15 UTC (1.25h late)
- 10 AM UTC: fires ~10:45 UTC (45m late)
- 20:00 UTC: fires ~20:30 UTC (30m late)

**Why:** GitHub queues scale down at off-peak hours. Late-night UTC crons have the worst delays.

**How to apply:** Shift time-sensitive crons 2h earlier to compensate. Use local launchd on Mac Studio as a reliable backup trigger for critical timing windows. The launchd plist is at `~/Library/LaunchAgents/com.bwsc.opening-night-backup-trigger.plist`.
