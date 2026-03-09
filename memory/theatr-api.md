# Theatr API Reference

## Base URL
`https://appapi.theatr-app.com`

## Auth
- Firebase-backed JWTs. Access tokens: 24h TTL. Refresh tokens: 30-day, single-use (rolls on each refresh).
- **Refresh:** `POST /v1/auth/access-tokens` with body `{"refreshToken": "..."}` → `{accessToken, refreshToken}`
- GitHub secret: `THEATR_REFRESH_TOKEN`. Workflow rotates after each run.
- User-Agent: `Theatr/184 CFNetwork/3860.400.51 Darwin/25.3.0`

## Endpoints
- `POST /shows/query` — Bulk listing. Body: `{"filters":{"eventTypes":["Musical","Play"...]},"sort":{"field":"numWatched","order":"desc"},"pageSize":9999}`. Returns `{data: [{id, name, eventCategory, numWatched, ...}]}`
- `GET /show-stats/{id}` — Per-show sentiment. Returns `{numLikes, numDislikes, numMixed, numWatched, numInterested}`

## Score Conversion
Three-way sentiment (richer than app UI shows):
```
weightedApproval = ((likes + mixed × 0.5) / (likes + dislikes + mixed)) × 100
```
No calibration needed vs ShowScore (mean diff: -2.3 pts across 135 shows).

## Coverage
- 271 Broadway, 978 Off-Broadway, **NO West End**
- ~230 matched to our shows.json with 10+ votes

## Script
`scripts/scrape-theatr-audience.js` — 2s delay between requests, MIN_VOTES=10.
Manual overrides in `THEATR_OVERRIDES` for title mismatches.

## Workflow
`update-theatr.yml` — Weekly Sundays 2 PM UTC. Concurrency: `audience-buzz`.
