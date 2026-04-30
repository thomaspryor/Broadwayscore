// Dynamic llms.txt for AI/LLM crawlers
// This file helps AI systems understand our site structure
// See: https://llmstxt.org/

import { getBroadwayShows, getWestEndShows, getOffWestEndShows, getAllBrowseSlugs } from '@/lib/data-core';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export async function GET() {
  const broadwayShows = getBroadwayShows();
  const westEndShows = getWestEndShows();
  const offWestEndShows = getOffWestEndShows();
  const shows = [...broadwayShows, ...westEndShows, ...offWestEndShows];
  const browseSlugs = getAllBrowseSlugs();

  // Count shows by status
  const openShows = shows.filter(s => s.status === 'open');
  const closedShows = shows.filter(s => s.status === 'closed');
  const previewShows = shows.filter(s => s.status === 'previews' || s.status === 'upcoming');

  // Broadway-specific counts (for the top-rated list we include all markets)
  const broadwayOpen = broadwayShows.filter(s => s.status === 'open').length;
  const westEndOpen = westEndShows.filter(s => s.status === 'open').length;
  const offWestEndOpen = offWestEndShows.filter(s => s.status === 'open').length;

  // Get top-rated shows for highlighting (across all markets)
  const topShows = shows
    .filter(s => s.criticScore?.score && s.criticScore.reviewCount >= 5)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .slice(0, 5);

  const content = `# Broadway Scorecard™ & West End Scorecard

> The independent theatre review aggregator. We combine critic reviews from major publications into a single composite score for every Broadway, West End, and Off-West End show.

## What We Do

Broadway Scorecard™ aggregates reviews from professional theatre critics (New York Times, Vulture, Variety, The Guardian, The Times, Evening Standard, The Stage, and more) and calculates a weighted score (0-100) for each show across Broadway (NYC), the West End (London), Off-Broadway, and Off-West End. Think "Rotten Tomatoes for theatre."

## Current Inventory

- **${openShows.length} shows currently running** (Broadway: ${broadwayOpen} · West End: ${westEndOpen} · Off-West End: ${offWestEndOpen})
- **${closedShows.length} closed shows** with historical data
- **${previewShows.length} upcoming shows** in previews
- **${shows.reduce((acc, s) => acc + (s.criticScore?.reviewCount || 0), 0)}+ critic reviews** aggregated across Broadway and the West End

## How Scoring Works

We use a per-region tier-weighted system:
- **Tier 1** (weight 1.0): Anchor outlets — NYT, Vulture, Variety (NYC anchors); Guardian, Times UK, Telegraph, Daily Mail, The Stage (London anchors)
- **Tier 2** (weight 0.75): Major editorial — TheaterMania, BroadwayWorld, Theater Life (NYC); WhatsOnStage, Arts Desk, British Theatre Guide (London)
- **Tier 3** (weight 0.40): General coverage and recognized single-author critics
- **Tier 4** (weight 0.20): Unverified single-author blogs

Tiers are per-region: NYT is T1 for Broadway shows but T2 for West End shows; The Stage is T1 for West End but T2 for Broadway. Off-Broadway shares NYC tier; Off-West-End shares London tier.

Each review is normalized to a 0-100 scale. The final score is a weighted average.

## Top-Rated Shows Right Now

${topShows.map((s, i) => `${i + 1}. **${s.title}** - Score: ${Math.round(s.criticScore?.score || 0)}/100 (${s.criticScore?.reviewCount} reviews) - [View Details](${BASE_URL}/show/${s.slug})`).join('\n')}

## Key Pages

### Main Navigation
- [All Shows](${BASE_URL}/): Browse all Broadway shows with scores and filters
- [Find the Best](${BASE_URL}/rankings): Browse all rankings by audience, genre, discount tickets, timing
- [How Scoring Works](${BASE_URL}/methodology): Our complete scoring methodology explained
- [Submit a Review](${BASE_URL}/submit-review): Help us add missing reviews
- [Send Feedback](${BASE_URL}/feedback): Report issues or suggest improvements

### Browse by Category
${browseSlugs.slice(0, 12).map(slug => {
  const title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `- [${title}](${BASE_URL}/browse/${slug})`;
}).join('\n')}

### Data & Analytics
- [Box Office Scorecard](${BASE_URL}/box-office): Weekly grosses, capacity, and all-time stats for every show
- [Commercial Scorecard](${BASE_URL}/biz-buzz): Which shows make money - recoupment data, capitalization, designations
- [AudienceGrade](${BASE_URL}/audience-buzz): What audiences think - Show Score, Mezzanine, Theatr, and Reddit ratings

### Discount Tickets
- [Best Value Tickets](${BASE_URL}/best-value): All discount options (lottery, rush, SRO) sorted by cheapest price
- [Broadway Lotteries](${BASE_URL}/lotteries): Digital lotteries for discounted tickets ($10-60)
- [Rush Tickets](${BASE_URL}/rush): Same-day rush tickets at box office or digital apps ($30-50)
- [Standing Room Only](${BASE_URL}/standing-room): Standing room tickets for sold-out shows ($35-50)

### Other Resources
- [Broadway Theater Map](${BASE_URL}/broadway-theaters-map): Interactive map of all Broadway theaters
- [Directors Index](${BASE_URL}/director): Browse shows by director
- [Theaters Index](${BASE_URL}/theater): Browse shows by theater

### West End (London)
- [West End Scorecard](${BASE_URL}/west-end): London theatre ratings and reviews
- [West End Audience Buzz](${BASE_URL}/west-end/audience-buzz): What London audiences think
- [Tony Awards](${BASE_URL}/tony-awards): Broadway's highest honor — winners, nominations, leaderboard
- [Olivier Awards](${BASE_URL}/olivier-awards): London's highest theatre honour — recent winners and their critic scores
- [West End Theatres](${BASE_URL}/west-end/theater): Browse every West End and Off-West End venue
- [West End Methodology](${BASE_URL}/west-end/methodology): How we score London theatre
- [West End Discount Tickets](${BASE_URL}/west-end/discount-tickets): Lotteries, day seats, rush, standing room

## Data We Provide For Each Show

- **CriticScore**: Weighted composite score (0-100)
- **Review Count**: Number of aggregated reviews
- **Individual Reviews**: Outlet, critic name, score, excerpt, link
- **Show Details**: Synopsis, creative team, runtime
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
