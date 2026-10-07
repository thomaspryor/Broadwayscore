# Social Infographics Session Handoff

Paste this into a new Claude Code session to continue:

---

## Resume Prompt

I'm building a social media posting pipeline for Broadway Scorecard. Here's where we left off:

### What's Done
- **`scripts/social-infographics/generate-all-posts.js`** — Main generation script that produces 16 infographic posts as HTML + Playwright screenshots in TWO sizes: 1:1 (2160x2160) for X/Bluesky/Facebook, and 4:5 (2160x2700) for Instagram/Threads
- **`scripts/social-infographics/gather-post-data.js`** — Data gathering from public show JSONs + master shows.json
- **All 16 posts generated** as HTML templates and PNG screenshots in `public/og/social/`
- Posts use shared CSS helpers (baseCSS, pageCSS, headerCSS, footerCSS, scoreBadgeCSS) with design tokens: `#0f0f14` bg, `#1a1a24` cards, `#d4a574` brand gold, Inter font

### The 16 Posts
1. Top 5 Running Shows (Hamilton 89, Maybe Happy Ending 85, Oh Mary! 84, Book of Mormon 84, Lion King 83)
2. Top Musicals All Time (Hamilton 89, Kimberly Akimbo 88, Strange Loop 86, Into the Woods 86, Fun Home 86)
3. Top Plays All Time (Stereophonic 89, Angels in America 88, Dana H. 86, Three Tall Women 86, Virginia Woolf 85)
4. **BLOCKED** — "Critics Loved, Audiences Didn't" — at 80+ cutoff only 2 shows qualify (Dividing the Estate 82/C+, Fela! 80/C+). Need user decision. Options: lower cutoff, flip concept, replace post entirely
5. Critics vs Audience Disagree — audience loved but critics meh (Stranger Things 65/A+, Wicked 69/A+, Great Gatsby 59/B+, Outsiders 72/A+, MJ 69/A-)
6. Two-column: Toughest vs Most Generous Critics
7. Best Broadway Seasons (2022-23 avg 72.5, filtered to 25+ shows per season)
8. Audience Loved, Critics Didn't (Don't Dress for Dinner 53/A-, Godspell 55/A-, etc.)
9. Highest Capacity Shows (week of March 1, 2026) — MUST refresh with latest grosses data when posted
10. Fastest Recoupments — green weeks-to-recoup badges (Waiting for Godot 8wks, Othello 9wks, etc.)
11. Most Expensive Broadway Shows (King Kong $36.5M, Harry Potter $35.5M, etc.)
12-16. Individual Show Scorecards (Hamilton, Wicked, Lion King, Harry Potter, Ragtime) — horizontal row of 5 blocks: CriticScore, Audience, T1, T2, T3

### What's Left
1. **Resolve Post 4** — user said shows are "all obscure" at 75+ cutoff, asked about 80+ but only 2 qualify. Waiting for direction.
2. **Write captions** for all 16 posts, per-platform:
   - Twitter/Bluesky/Threads: short <280 chars, no hashtags
   - Instagram/Facebook: 2-3 sentences with hashtags
   - Tone: "Look what the data says" — confident, curious, not corporate
3. **Schedule to Buffer via MCP** — 5 channels (IG, X, Threads, Bluesky, FB page), 80 total API calls (16 posts x 5 channels)
   - Posts 1-9: one per day (filling feed before following anyone)
   - Posts 10-16: one every other day
   - Use `addToQueue` (Buffer's optimal timing)
4. **Images need URLs** for Buffer — PNGs in `public/og/social/` need to be accessible via URL

### Key Technical Notes
- Score computation: tier-weighted (T1=1.0, T2=0.75, T3=0.35), NOT simple average
- Audience grades are letter grades only (A+ >= 90, A >= 88, etc.) — NEVER show numeric audience scores externally
- Show images: `.webp` default, some use `.jpg` (check `posterExt` field)
- `data/shows.json` has full metadata (numeric keys), public JSONs have minified fields (rv, s, t, o, au, pd, id)
- Read `scripts/social-infographics/generate-all-posts.js` first — it has all the template code
