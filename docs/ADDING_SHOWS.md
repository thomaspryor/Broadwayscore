# Adding New Shows to Broadway Scorecard

This guide covers the required steps for adding a new Broadway show to the database.

---

## Required Data for Each Show

### 1. Basic Metadata

Add the show to `data/shows.json` with these required fields:

```json
{
  "id": "show-name-year",
  "title": "Show Name",
  "slug": "show-name",
  "venue": "Theater Name",
  "openingDate": "YYYY-MM-DD",
  "closingDate": null,
  "status": "open",
  "type": "musical|play|revival",
  "runtime": "2h 30m",
  "intermissions": 1
}
```

### 2. Images

Fetch images from TodayTix CDN (Contentful):

```json
"images": {
  "poster": "https://images.ctfassets.net/...",
  "thumbnail": "https://images.ctfassets.net/...",
  "hero": "https://images.ctfassets.net/..."
}
```

### 3. Synopsis & Details

```json
"synopsis": "A brief 2-3 sentence description of the show...",
"ageRecommendation": "Ages 12+",
"tags": ["Musical", "Comedy", "New"],
"officialUrl": "https://showname.com",
"theaterAddress": "123 W 45th St, New York, NY 10036"
```

### 4. Ticket Links (Required)

**Every show must have ticket links.** Find URLs from these sources:

| Source | URL Pattern |
|--------|-------------|
| **TodayTix** | `https://www.todaytix.com/nyc/shows/{id}-{show-name}` |
| **Telecharge** | `https://www.telecharge.com/Broadway/{Show-Name}` (Shubert theaters) |
| **Ticketmaster** | `https://www.ticketmaster.com/{show-name}-tickets/artist/{id}` (Nederlander theaters) |

Determine the correct secondary platform by theater ownership:
- **Shubert Organization** theaters: Use Telecharge
- **Nederlander Organization** theaters: Use Ticketmaster
- **Jujamcyn** theaters: Usually Telecharge

```json
"ticketLinks": [
  {
    "platform": "TodayTix",
    "url": "https://www.todaytix.com/nyc/shows/12345-show-name"
  },
  {
    "platform": "Telecharge",
    "url": "https://www.telecharge.com/Broadway/Show-Name"
  }
]
```

Optional `priceFrom` field if known:
```json
{
  "platform": "TodayTix",
  "url": "https://www.todaytix.com/nyc/shows/12345-show-name",
  "priceFrom": 59
}
```

### 5. Cast & Creative Team

```json
"cast": [
  { "name": "Actor Name", "role": "Character Name" }
],
"creativeTeam": [
  { "name": "Director Name", "role": "Director" },
  { "name": "Composer Name", "role": "Music" }
]
```

---

## Checklist for New Shows

- [ ] Basic metadata added (id, title, slug, venue, dates, status, type)
- [ ] Images fetched (poster, thumbnail, hero)
- [ ] Synopsis written
- [ ] Age recommendation set
- [ ] Tags added
- [ ] **Ticket links added** (TodayTix + Telecharge/Ticketmaster)
- [ ] Theater address included
- [ ] Cast added (at minimum, leads)
- [ ] Creative team added (director, composer/lyricist, book writer)
- [ ] JSON validates successfully
- [ ] Build passes

---

## Theater Ownership Reference

### Shubert Organization (use Telecharge)
- Ambassador, Barrymore, Belasco, Booth, Broadhurst, Broadway, Cort (renamed James Earl Jones), Golden, Hayes (Second Stage), Imperial, Jacobs, Longacre, Lyceum, Majestic, Schoenfeld, Shubert, Winter Garden

### Nederlander Organization (use Ticketmaster)
- Brooks Atkinson, Gershwin, Lena Horne, Lunt-Fontanne, Lyric, Marquis, Minskoff, Nederlander, Neil Simon, New Amsterdam, Palace, Richard Rodgers

### Roundabout Theatre Company (use Telecharge)
- Stephen Sondheim Theatre, Studio 54, American Airlines Theatre

### Disney (use Ticketmaster)
- New Amsterdam Theatre
