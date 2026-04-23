# Broadway Scorecard

**Every show. Every review. One score.**

[broadwayscorecard.com](https://broadwayscorecard.com)

Broadway Scorecard aggregates critic reviews from 420+ outlets and 870+ critics to generate a single composite score for every Broadway show. Scores are tier-weighted — major national publications carry more weight than niche blogs — producing a reliable signal for theatergoers deciding what to see.

## At a Glance

- **721+ shows** scored across Broadway, West End, and Off-Broadway
- **16,000+ critic reviews** collected and scored
- **420+ outlets** tracked, from the New York Times to regional theater blogs
- **Audience grades** alongside critic scores for a complete picture
- **Box office data** with weekly grosses, capacity, and commercial analysis
- **Tony Award predictions** powered by historical critic-commercial correlation
- **Discount ticket tracking** — lotteries, rush, standing room, and TKTS availability

## How Scoring Works

Each review is scored on a 0–100 scale and assigned a tier based on the outlet's reach and editorial standards. The composite score is a weighted average across tiers, ensuring that a rave in the New York Times counts more than a blog post — but every review still contributes.

Score tiers at a glance:

| Range | Label | Meaning |
|-------|-------|---------|
| 83–100 | Critical Gold | Drop-everything great |
| 75–82 | Recommended | Strong choice for most people |
| 65–74 | Worth Seeing | Good, with caveats |
| 55–64 | Skippable | Fine to miss |
| < 55 | Critical Miss | Not recommended |

Full methodology: [broadwayscorecard.com/methodology](https://broadwayscorecard.com/methodology)

## Tech Stack

- **Next.js 14** with TypeScript and Tailwind CSS
- **Static export** for fast, cache-friendly page loads
- **139 automated workflows** handling data collection, scoring, validation, and deployment
- **Automated data pipelines** collecting reviews, grosses, and ticket availability daily

## Related Repos

| Repo | GitHub | Local dir | Purpose |
|------|--------|-----------|---------|
| Web | `thomaspryor/Broadwayscore` | `~/Broadwayscore/` | Next.js site, scoring engine, data pipelines |
| iOS app | `thomaspryor/BroadwayScorecard-app` | `~/BroadwayScorecard-app/` | Expo/React Native mobile app |
| Data | `thomaspryor/broadway-scorecard-data` | `~/broadway-scorecard-data/` | Review texts, core data (private) |

## Data Architecture

The application code and scoring engine live in this repository. Review texts and core data are stored separately to respect copyright and keep the public repo clean.

## License

Copyright 2024–2026 Broadway Scorecard LLC. All rights reserved.

This source code is provided for reference purposes. See [broadwayscorecard.com/terms](https://broadwayscorecard.com/terms) for full terms.
