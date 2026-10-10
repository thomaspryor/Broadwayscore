---
name: TodayTix deep-link architecture
description: "/booking/seating-plan is the only date-specific path; time-order classify."
type: feedback
archived: true
---

No ticket platform (TodayTix, Ticketmaster, Telecharge, StubHub, SeatGeek, Vivid Seats) supports a `?date=` param on show-level URLs. The only date-specific path is TodayTix's `/booking/seating-plan?showId=X&showtimeId=Y` (public API, no auth).

**Why:** TodayTix's consumer web app calendar is a client-side-only component with zero URL state management. The seating-plan path is a white-label checkout entry point.

**How to apply:** Deep links require per-performance showtime IDs from `api.todaytix.com/api/v2/shows/{id}/showtimes`. Daily cron fetches these. The `todaytixShowtimes` prop is passed from server component to avoid bundling 960KB JSON into client. TodayTix daypart field is unreliable for 17:00 shows — use time-order classification (earliest=m, latest=e) when multiple shows per day.
