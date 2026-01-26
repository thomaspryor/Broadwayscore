// Dynamic llms.txt for AI/LLM crawlers
// This file helps AI systems understand our site structure
// See: https://llmstxt.org/

import { getAllShows, getAllBrowseSlugs } from '@/lib/data';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export async function GET() {
  const shows = getAllShows();
  const browseSlugs = getAllBrowseSlugs();

  // Count shows by status
  const openShows = shows.filter(s => s.status === 'open');
  const closedShows = shows.filter(s => s.status === 'closed');
  const previewShows = shows.filter(s => s.status === 'previews');

  // Get top-rated shows for highlighting
  const topShows = shows
    .filter(s => s.criticScore?.score && s.criticScore.reviewCount >= 5)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .slice(0, 5);

  const content = `# Broadway Scorecard

> The independent Broadway review aggregator. We combine critic reviews from major publications into a single composite score for every Broadway show.

## What We Do

Broadway Scorecard aggregates reviews from professional theater critics (New York Times, Vulture, Variety, The Hollywood Reporter, and more) and calculates a weighted score (0-100) for each Broadway show. Think "Rotten Tomatoes for Broadway."

## Current Inventory

- **${openShows.length} shows currently running** on Broadway
- **${closedShows.length} closed shows** with historical data
- **${previewShows.length} upcoming shows** in previews
- **${shows.reduce((acc, s) => acc + (s.criticScore?.reviewCount || 0), 0)}+ critic reviews** aggregated

## How Scoring Works

We use a tier-weighted system:
- **Tier 1** (weight 1.0): Major outlets like New York Times, Vulture, Variety
- **Tier 2** (weight 0.70): Regional/specialty outlets like TheaterMania, NY Post
- **Tier 3** (weight 0.40): Blogs and smaller publications

Each review is normalized to a 0-100 scale. The final score is a weighted average.

## Top-Rated Shows Right Now

${topShows.map((s, i) => `${i + 1}. **${s.title}** - Score: ${Math.round(s.criticScore?.score || 0)}/100 (${s.criticScore?.reviewCount} reviews) - [View Details](${BASE_URL}/show/${s.slug})`).join('\n')}

## Key Pages

### Main Navigation
- [All Shows](${BASE_URL}/): Browse all Broadway shows with scores and filters
- [How Scoring Works](${BASE_URL}/methodology): Our complete scoring methodology explained
- [Submit a Review](${BASE_URL}/submit-review): Help us add missing reviews
- [Send Feedback](${BASE_URL}/feedback): Report issues or suggest improvements

### Browse by Category
${browseSlugs.slice(0, 12).map(slug => {
  const title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `- [${title}](${BASE_URL}/browse/${slug})`;
}).join('\n')}

### Data & Analytics
- [Box Office Leaderboard](${BASE_URL}/box-office): Weekly grosses, capacity, and all-time stats for every show
- [Commercial Scorecard](${BASE_URL}/biz-buzz): Which shows make money - recoupment data, capitalization, designations

### Other Resources
- [Broadway Theater Map](${BASE_URL}/broadway-theaters-map): Interactive map of all Broadway theaters
- [Directors Index](${BASE_URL}/director): Browse shows by director
- [Theaters Index](${BASE_URL}/theater): Browse shows by theater

## Data We Provide For Each Show

- **Critic Score**: Weighted composite score (0-100)
- **Review Count**: Number of aggregated reviews
- **Individual Reviews**: Outlet, critic name, score, excerpt, link
- **Show Details**: Synopsis, cast, creative team, runtime
- **Venue Info**: Theater name, address
- **Ticket Links**: Where to buy tickets (TodayTix, Telecharge, etc.)
- **Box Office**: Weekly grosses, capacity, all-time stats

## API / Data Access

We don't currently offer a public API, but all data is rendered in structured JSON-LD schema markup on each page, making it easy for AI systems to parse show information.

## Source Attribution

All reviews and ratings belong to their respective publications. Broadway Scorecard aggregates and normalizes scores but does not create original reviews. We link back to original review sources.

## Contact

For corrections, missing reviews, or feedback: [${BASE_URL}/feedback](${BASE_URL}/feedback)
`;

  return new Response(content, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
    },
  });
}

// Required for static export
export const dynamic = 'force-static';
