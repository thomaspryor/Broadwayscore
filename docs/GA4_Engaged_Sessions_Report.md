# GA4 `sessions_engaged` Report — Headline Traffic KPI

**Linear:** [BRO-44](https://linear.app/broadway-scorecard/issue/BRO-44/switch-headline-traffic-kpi-to-engaged-sessions-drop-direct-bots)

## Problem

GA4's `Direct` channel is ~80% bot traffic — verified May 2026 at 6.2% engagement
and 23s average session duration, a clear non-human signature. Direct drove 79%
of reported sessions that month (32,168 total sessions vs 5,680 engaged
sessions), so any headline "sessions" number overstated real engagement by
roughly 5x. PostHog independently confirms ~49% bot inflation on the homepage
alone (see `memory/feedback_analytics_real_users_lens.md`).

Raw GA4 `sessions` is not a trustworthy headline traffic KPI. This doc defines
the replacement.

## The report

GA4's `engagedSessions` metric already excludes non-engaged sessions: a session
only counts as "engaged" if it lasted 10+ seconds, fired a conversion event, or
had 2+ pageviews/screenviews. Bots that fetch one URL and leave (the Direct
bot signature above) essentially never trigger any of those, so `engagedSessions`
drops the vast majority of the bot volume without needing a separate
channel-level filter on top.

**Headline KPI = `engagedSessions`, summed across all channels, for the report
window.** No further Direct-specific exclusion is applied on top of it — the
per-channel breakdown (below) is reported alongside it for transparency, not
because Direct needs to be subtracted again.

### Definition (GA4 Data API)

```js
{
  dimensions: [{ name: 'sessionDefaultChannelGroup' }],
  metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
  orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
}
```

Why this isn't a GA4 UI "saved report" / Exploration: the GA4 Admin API has no
public endpoint for creating Reports-UI saved reports or Explorations, so
there's no way to provision one headlessly. Every other traffic report in this
repo (`ticket-clicks`, `top-pages`, `traffic`, `geo-audit`, …) is likewise
implemented as a versioned, documented query in `scripts/query-analytics.js`
rather than a GA4 UI artifact — this report follows the same, already-established
pattern so it's runnable in CI/cron without a browser session.

### Implementation

- **Shared logic:** `scripts/lib/ga4-engaged-sessions.js` — `fetchEngagedSessionsSummary(client, propertyId, dateRange)` runs the query above; `summarizeChannelRows(rows)` is the pure aggregation (unit-tested in the colocated `.test.mjs`).
- **Manual/ad-hoc query:** `node scripts/query-analytics.js sessions-engaged [--days=N | --start=... --end=...]`
- **Automated cron:** `scripts/audit-geo-bots.js` (run weekly by `.github/workflows/weekly-geo-audit.yml`) now logs the headline KPI — engaged sessions, raw sessions, inflation ratio, and the Direct-channel breakdown — at the top of every run, before its existing per-country bot audit. This is the one recurring scheduled job in the repo that queries GA4 traffic, so it's the default location for the headline number.

### Output shape

```
totalSessions          — raw sessions, all channels
totalEngagedSessions   — engaged sessions, all channels (THE HEADLINE)
direct                 — { channel: 'Direct', sessions, engagedSessions }
sessionsExDirect       — raw sessions excluding Direct
engagedSessionsExDirect— engaged sessions excluding Direct
headline                — alias for totalEngagedSessions
inflationRatio          — totalSessions / totalEngagedSessions (null if 0 engaged)
```

## Cross-check

PostHog's "Real Users" lens (`memory/feedback_analytics_real_users_lens.md`,
project 332742) is the independent, non-GA4 source of truth for absolute
traffic counts — it filters bots client-side and barely moves when the Real
Users lens is applied, confirming the bot problem is concentrated in GA4's
own Direct-channel accounting rather than in actual site traffic. Use GA4
`engagedSessions` for channel/trend shape reported via this tool and cron;
use PostHog when an absolute-count claim needs to be defensible.
