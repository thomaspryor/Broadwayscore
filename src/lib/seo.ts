// SEO Utilities - Structured Data Schemas for Rich Search Results

import { ComputedShow } from './engine';
import { isLondonMarket, getMarketCountry, getMarketCurrency, getMarketMinReviews, getMarketLabel } from './venue-classification';
import { isOperaShow } from './show-market';
import { getGoldThreshold } from '@/config/score-buckets';
import { isPlatformHidden } from './ticket-utils';

export const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// Ensure image URLs are absolute for OG tags and JSON-LD
export function toAbsoluteUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

// Build hreflang/canonical alternates for pages mirrored across Broadway and West End markets.
// Returns canonical (self) + reciprocal en-US/en-GB language alternates + x-default fallback.
// Both URLs MUST exist — Google silently ignores hreflang when the alternate 404s.
export function marketAlternates(
  currentMarket: 'broadway' | 'westEnd',
  sharedPath: string
): { canonical: string; languages: Record<string, string> } {
  // sharedPath is the Broadway-relative path (e.g. '/discount-tickets'). The
  // helper applies the '/west-end' prefix itself. Passing '/west-end/...'
  // would produce '/west-end/west-end/...' — reject at the call site.
  if (sharedPath.startsWith('/west-end')) {
    throw new Error(
      `marketAlternates: sharedPath must be the Broadway-relative path without /west-end prefix; got ${sharedPath}`
    );
  }
  const broadwayUrl = `${BASE_URL}${sharedPath}`;
  const westEndUrl = `${BASE_URL}/west-end${sharedPath}`;
  const selfUrl = currentMarket === 'broadway' ? broadwayUrl : westEndUrl;
  return {
    canonical: selfUrl,
    languages: {
      'en-US': broadwayUrl,
      'en-GB': westEndUrl,
      'x-default': broadwayUrl,
    },
  };
}

// Convert 0-100 score to 1-5 star scale for schema.org
// Google prefers 1-5 scale for rich snippet star display
function toFiveStarScale(score: number): number {
  return Math.round((score / 100) * 4 * 10) / 10 + 1; // 0→1.0, 50→3.0, 100→5.0
}

// Organization Schema - Site identity
export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Broadway Scorecard',
    url: BASE_URL,
    logo: `${BASE_URL}/og/home.png`,
    description: 'Aggregated Broadway show ratings from professional critics',
    inLanguage: 'en',
  };
}

// Parse address string like "226 W 46th St, New York, NY 10036" into PostalAddress
function toPostalAddress(address: string, country: string = 'US') {
  const match = address.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5})$/);
  if (match) {
    return {
      '@type': 'PostalAddress',
      streetAddress: match[1],
      addressLocality: match[2],
      addressRegion: match[3],
      postalCode: match[4],
      addressCountry: country,
    };
  }
  return address;
}

// WebSite Schema - For sitelinks search box
export function generateWebSiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Broadway Scorecard',
    url: BASE_URL,
    inLanguage: 'en',
    description: 'Comprehensive Broadway show ratings combining critic reviews, AudienceGrade ratings, and community buzz.',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${BASE_URL}/?search={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

// BreadcrumbList Schema - Navigation context
export function generateBreadcrumbSchema(items: { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

// TheaterEvent Schema with full details (enhanced)
export function generateShowSchema(show: ComputedShow, lastUpdated?: string, performers?: { name: string }[]) {
  const isLondon = isLondonMarket(show.category);
  const country = getMarketCountry(show.category);
  const currency = getMarketCurrency(show.category);
  // Event spec requires startDate. Fall back to previewsStartDate when openingDate
  // isn't yet announced.
  const startDate = show.openingDate || show.previewsStartDate;
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TheaterEvent',
    name: show.title,
    description: show.synopsis,
    url: `${BASE_URL}/show/${show.slug}`,
    inLanguage: 'en',
    location: {
      '@type': 'PerformingArtsTheater',
      name: show.venue,
      address: toPostalAddress(show.theaterAddress || show.venue, country),
    },
    ...(startDate && { startDate }),
    ...(show.closingDate && { endDate: show.closingDate }),
    ...(show.images?.hero && { image: toAbsoluteUrl(show.images.hero) }),
    ...(lastUpdated && { dateModified: lastUpdated }),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    // @id makes this entity referenceable by @id from critic Review schemas
    // in the same @graph document (see show page injection in page.tsx).
    '@id': `${BASE_URL}/show/${show.slug}#event`,
  };

  // Add aggregate rating if we have scores and sufficient reviews
  // Uses 1-5 star scale for Google rich snippet compatibility
  const minReviewsForSchema = getMarketMinReviews(show.category);
  if (show.criticScore?.score && show.criticScore?.reviewCount >= minReviewsForSchema) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: toFiveStarScale(show.criticScore.score),
      bestRating: 5,
      worstRating: 1,
      reviewCount: show.criticScore.reviewCount,
    };
  }

  // Note: Individual review snippets are NOT valid on TheaterEvent per Google's
  // structured data spec. Only aggregateRating is supported for Event types.
  // Individual reviews were causing "Invalid object type for field '<parent_node>'"
  // errors in Google Search Console.

  // Add ticket offers (excluding hidden platforms — stale/non-converting affiliates)
  if (show.ticketLinks && show.ticketLinks.length > 0) {
    const visibleLinks = show.ticketLinks.filter(l => !isPlatformHidden(l.platform));
    if (visibleLinks.length > 0) {
      schema.offers = visibleLinks.map(link => ({
        '@type': 'Offer',
        url: link.url,
        priceCurrency: currency,
        ...(link.priceFrom && { price: link.priceFrom }),
        availability: 'https://schema.org/InStock',
        seller: {
          '@type': 'Organization',
          name: link.platform,
        },
      }));
    }
  }

  // Add director
  const director = show.creativeTeam?.find(m =>
    m.role.toLowerCase().includes('director') && !m.role.toLowerCase().includes('music')
  );
  if (director) {
    schema.director = {
      '@type': 'Person',
      name: director.name,
    };
  }

  // Add performers from cast data (top 10 to avoid bloated JSON-LD)
  if (performers && performers.length > 0) {
    schema.performer = performers.slice(0, 10).map(p => ({
      '@type': 'Person',
      name: p.name,
    }));
  }

  return schema;
}

// Contrastive openers signal a mid-review qualifier (e.g. "But the second act
// drags...") rather than a blurb-quality quote. Strip these because Google
// review snippets show the quote next to the show title in SERPs.
const CONTRASTIVE_OPENER_RE = /^\s*(but|however|still|yet|though|although|granted|unfortunately|fortunately|sadly|alas|nevertheless|nonetheless|honestly)\b/i;

// Buckets that signal a positive critical reception. Used to gate which
// reviews are eligible for SERP-facing CriticReview snippets.
const POSITIVE_BUCKETS = new Set(['rave', 'positive']);

// CriticReview Schema - Top-level Review objects pointing back to the show.
//
// This is the supported pattern for Google's "review snippet" rich result on
// Event types. The earlier attempt nested `review` arrays inside TheaterEvent
// (commit de1f2cba09) and was rejected by GSC with "Invalid object type for
// field '<parent_node>'". Top-level Review objects with `itemReviewed` are the
// correct shape per https://developers.google.com/search/docs/appearance/structured-data/review-snippet
//
// Eligible reviews:
//   - T1/T2 outlets only
//   - Score >= 70 OR positive bucket (Rave/Positive). Negative quotes will hurt
//     CTR if Google renders them next to the show title — better no snippet
//     than a bad snippet.
//   - Excerpt >= 30 chars and doesn't open with a contrastive conjunction
//     ("But...", "However...", etc) which signals a mid-review qualifier.
// Capped at 8 to keep JSON-LD payload small. Each Review references the show
// via itemReviewed so Google can associate the rating with the correct entity.
export function generateCriticReviewsSchema(
  show: ComputedShow,
  reviews: Array<{
    outlet: string;
    criticName?: string;
    url: string;
    publishDate: string;
    tier: 1 | 2 | 3 | 4;
    reviewScore: number;
    bucket?: string;
    quote?: string;
    summary?: string;
    pullQuote?: string;
  }>,
): Record<string, unknown>[] {
  if (!reviews || reviews.length === 0) return [];

  // Reference the main TheaterEvent entity by @id rather than inlining a new
  // incomplete TheaterEvent object. Each Review's itemReviewed previously created
  // 8 additional TheaterEvent candidates missing startDate/location → GSC FAIL.
  // The @id reference resolves within the @graph document emitted by the show page.
  const itemReviewed = { '@id': `${BASE_URL}/show/${show.slug}#event` };

  const eligible = reviews
    .filter(r => r.tier === 1 || r.tier === 2)
    .filter(r => {
      // Sentiment gate: require positive critical reception
      const bucket = (r.bucket || '').toLowerCase();
      return r.reviewScore >= 70 || POSITIVE_BUCKETS.has(bucket);
    })
    .filter(r => {
      // Note: only pullQuote is currently populated by the pipeline. The
      // quote/summary fields are reserved on the type for future use.
      const text = (r.quote || r.summary || r.pullQuote || '').trim();
      if (text.length < 30) return false;
      // Reject contrastive openers — they signal mid-review qualifiers, not
      // blurb-quality opening lines.
      if (CONTRASTIVE_OPENER_RE.test(text)) return false;
      return true;
    })
    .filter(r => r.outlet && r.publishDate)
    .slice(0, 8);

  return eligible.map(r => {
    const rawBody = (r.quote || r.summary || r.pullQuote || '').trim();
    // Cap excerpt length so JSON-LD doesn't bloat the page
    const reviewBody = rawBody.length > 300 ? `${rawBody.slice(0, 297)}...` : rawBody;

    const review: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Review',
      itemReviewed,
      author: r.criticName
        ? { '@type': 'Person', name: r.criticName }
        : { '@type': 'Organization', name: r.outlet },
      datePublished: r.publishDate,
      reviewBody,
      reviewRating: {
        '@type': 'Rating',
        ratingValue: toFiveStarScale(r.reviewScore),
        bestRating: 5,
        worstRating: 1,
      },
    };

    // Add publisher only when distinct from author (i.e. when we have a critic name)
    if (r.criticName && r.outlet) {
      review.publisher = { '@type': 'Organization', name: r.outlet };
    }

    if (r.url) {
      review.url = r.url;
    }

    return review;
  });
}


// PerformingArtsTheater Schema - For theater pages
export function generateTheaterSchema(theater: {
  name: string;
  slug: string;
  address?: string;
  currentShow?: { title: string; slug: string };
  pastShows: { title: string; slug: string }[];
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'PerformingArtsTheater',
    name: theater.name,
    url: `${BASE_URL}/theater/${theater.slug}`,
    ...(theater.address && { address: toPostalAddress(theater.address) }),
    event: theater.currentShow ? {
      '@type': 'TheaterEvent',
      name: theater.currentShow.title,
      url: `${BASE_URL}/show/${theater.currentShow.slug}`,
      location: {
        '@type': 'PerformingArtsTheater',
        name: theater.name,
        ...(theater.address && { address: toPostalAddress(theater.address) }),
      },
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    } : undefined,
  };
}

// ItemList Schema - For browse/best-of pages
export function generateItemListSchema(items: {
  name: string;
  url: string;
  image?: string;
  score?: number;
  reviewCount?: number;
  venue?: string;
  theaterAddress?: string;
  startDate?: string;
  endDate?: string | null;
  description?: string;
  status?: string;
  ticketLinks?: { platform: string; url: string; priceFrom?: number }[];
  category?: string;
}[], listName: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: listName,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => {
      const event: Record<string, unknown> = {
        '@type': 'TheaterEvent',
        name: item.name,
        url: item.url,
        ...(item.image && { image: toAbsoluteUrl(item.image) }),
        ...(item.description && { description: item.description }),
      };

      // Location (required for TheaterEvent per Google structured data)
      event.location = item.venue ? {
        '@type': 'PerformingArtsTheater',
        name: item.venue,
        address: item.theaterAddress ? toPostalAddress(item.theaterAddress, getMarketCountry(item.category)) : item.venue,
      } : {
        '@type': 'PerformingArtsTheater',
        name: item.category === 'opera' ? 'Metropolitan Opera House' : isLondonMarket(item.category) ? 'West End Theatre' : item.category === 'off-broadway' ? 'Off-Broadway Theater' : 'Broadway Theater',
        address: toPostalAddress(
          isLondonMarket(item.category) ? 'London, England' : 'New York, NY',
          getMarketCountry(item.category)
        ),
      };

      // Dates
      if (item.startDate) {
        event.startDate = item.startDate;
      }
      if (item.endDate) {
        event.endDate = item.endDate;
      }

      // Event status (required for TheaterEvent per Google structured data)
      event.eventStatus = 'https://schema.org/EventScheduled';
      event.eventAttendanceMode = 'https://schema.org/OfflineEventAttendanceMode';

      // Organizer
      event.organizer = {
        '@type': 'Organization',
        name: item.category === 'opera' ? 'Opera Scorecard' : isLondonMarket(item.category) ? 'West End Scorecard' : item.category === 'off-broadway' ? 'Off-Broadway Scorecard' : 'Broadway Scorecard',
        url: BASE_URL,
      };

      // Aggregate rating (with required reviewCount, minimum 3)
      // Uses 1-5 star scale for Google rich snippet compatibility
      if (item.score && item.reviewCount && item.reviewCount >= 3) {
        event.aggregateRating = {
          '@type': 'AggregateRating',
          ratingValue: toFiveStarScale(item.score),
          bestRating: 5,
          worstRating: 1,
          reviewCount: item.reviewCount,
        };
      }

      // Ticket offers (excluding hidden platforms)
      if (item.ticketLinks && item.ticketLinks.length > 0) {
        const itemCurrency = getMarketCurrency(item.category);
        const visibleLinks = item.ticketLinks.filter(l => !isPlatformHidden(l.platform));
        if (visibleLinks.length > 0) {
          event.offers = visibleLinks.map(link => ({
            '@type': 'Offer',
            url: link.url,
            priceCurrency: itemCurrency,
            ...(link.priceFrom && { price: link.priceFrom }),
            availability: 'https://schema.org/InStock',
            seller: {
              '@type': 'Organization',
              name: link.platform,
            },
          }));
        }
      }

      return {
        '@type': 'ListItem',
        position: index + 1,
        item: event,
      };
    }),
  };
}

// FAQPage Schema - For show pages and other FAQ content
// FAQ schema increases AI citations by 28% and makes pages 3.2x more likely to appear in AI Overviews
export function generateShowFAQSchema(show: ComputedShow) {
  const score = show.criticScore?.score ? Math.round(show.criticScore.score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;
  const isLondon = isLondonMarket(show.category);
  const isOffBroadway = show.category === 'off-broadway';
  const isOpera = isOperaShow(show);
  const marketLabel = isOpera ? 'at the Met' : isLondon ? 'in London' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';

  const faqs: { question: string; answer: string }[] = [];

  const minReviewsForFAQ = getMarketMinReviews(show.category);

  // Q: Is it worth seeing? (highest-intent query — placed first for AI Overview targeting)
  if (score && reviewCount >= minReviewsForFAQ) {
    const goldMin = getGoldThreshold(show.category);
    const worthSeeingAnswer =
      score >= goldMin
        ? `Absolutely — ${show.title} is one of the season's most acclaimed shows, earning a rare ${score}/100 from ${reviewCount} critics. Don't miss it.`
        : score >= 75
        ? `Yes. ${show.title} earns strong reviews from critics (${score}/100 from ${reviewCount} reviews). Most theatergoers will have a great time.`
        : score >= 65
        ? `Probably, if the material interests you. Critics say ${show.title} is worth seeing (${score}/100 from ${reviewCount} reviews) — it works best if the premise or cast appeals to you.`
        : score >= 55
        ? `Only if you're a devoted fan. Critics are mixed on ${show.title} (${score}/100 from ${reviewCount} reviews). Most suggest you could skip it.`
        : `Probably not. Critics generally don't recommend ${show.title} (${score}/100 from ${reviewCount} reviews). Save your time and money unless you have a specific reason to go.`;
    faqs.push({
      question: `Is ${show.title} worth seeing?`,
      answer: worthSeeingAnswer,
    });
  }

  // Q: What is the score?
  if (score && reviewCount >= minReviewsForFAQ) {
    const goldMin = getGoldThreshold(show.category);
    faqs.push({
      question: `What is the CriticScore for ${show.title}?`,
      answer: `${show.title} has a CriticScore of ${score}/100 based on ${reviewCount} professional reviews. ${
        score >= goldMin ? 'This is considered a "Critical Gold" show.' :
        score >= 75 ? 'This is a "Recommended" show.' :
        score >= 65 ? 'This is rated "Worth Seeing".' :
        score >= 55 ? 'This show is rated "Skippable".' :
        'Critics generally did not recommend this show.'
      }`,
    });
  }

  // Q: Is it still running?
  faqs.push({
    question: `Is ${show.title} still running ${marketLabel}?`,
    answer: show.status === 'open'
      ? `Yes, ${show.title} is currently playing at ${show.venue} ${marketLabel}.${show.closingDate ? ` It is scheduled to close on ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.` : ''}`
      : show.status === 'previews'
      ? `${show.title} is currently in previews at ${show.venue}. It officially opens on ${new Date(show.openingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
      : show.status === 'upcoming'
      ? `${show.title} is upcoming at ${show.venue}. Previews begin ${show.previewsStartDate ? new Date(show.previewsStartDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'soon'} and it officially opens on ${new Date(show.openingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
      : `No, ${show.title} has closed. It played at ${show.venue}${show.closingDate ? ` and closed on ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}.`,
  });

  // Q: Where is it playing?
  if (show.status !== 'closed') {
    faqs.push({
      question: `Where is ${show.title} playing ${marketLabel}?`,
      answer: `${show.title} is playing at ${show.venue}${show.theaterAddress ? `, located at ${show.theaterAddress}` : ''}.`,
    });
  }

  // Q: How long is it?
  if (show.runtime) {
    // Runtime can be "2h 45m" (string) or 135 (number = total minutes)
    const rt = String(show.runtime);
    const hMatch = rt.match(/(\d+)\s*h/);
    const mMatch = rt.match(/(\d+)\s*m/);
    let hours: number, mins: number;
    if (hMatch || mMatch) {
      hours = hMatch ? parseInt(hMatch[1], 10) : 0;
      mins = mMatch ? parseInt(mMatch[1], 10) : 0;
    } else {
      // Plain number = total minutes
      const totalMins = parseInt(rt, 10);
      hours = Math.floor(totalMins / 60);
      mins = totalMins % 60;
    }
    if (hours > 0 || mins > 0) {
      const runtimeStr = hours > 0
        ? `${hours} hour${hours > 1 ? 's' : ''}${mins > 0 ? ` and ${mins} minutes` : ''}`
        : `${mins} minutes`;
      faqs.push({
        question: `How long is ${show.title}?`,
        answer: `${show.title} has a runtime of ${runtimeStr}${show.intermissions ? `, including ${show.intermissions} intermission${show.intermissions > 1 ? 's' : ''}` : ' with no intermission'}.`,
      });
    }
  }

  // Q: Is it good for kids?
  if (show.ageRecommendation) {
    faqs.push({
      question: `Is ${show.title} appropriate for children?`,
      answer: `${show.title} is recommended for ${show.ageRecommendation}.`,
    });
  }

  if (faqs.length === 0) return null;

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}

// FAQPage Schema for browse/category pages
export function generateBrowseFAQSchema(
  pageTitle: string,
  shows: { title: string; slug: string; venue?: string; criticScore?: { score: number; reviewCount: number } | null; status?: string; closingDate?: string | null; type?: string; category?: string }[],
) {
  const isLondon = shows.length > 0 && isLondonMarket(shows[0].category);
  const isOffBroadway = shows.length > 0 && shows[0].category === 'off-broadway';
  const marketLabel = isLondon ? 'in London' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
  const outletNames = isLondon
    ? 'The Guardian, Telegraph, Time Out, and WhatsOnStage'
    : 'The New York Times, Vulture, and Variety';
  if (shows.length === 0) return null;

  const faqs: { question: string; answer: string }[] = [];

  // Q: What are the best shows in this category?
  const firstCategory = shows.length > 0 ? shows[0].category : undefined;
  const minReviewsForBrowse = getMarketMinReviews(firstCategory);
  const topShows = shows
    .filter(s => s.criticScore?.score && s.criticScore.reviewCount >= minReviewsForBrowse)
    .slice(0, 5);

  if (topShows.length >= 2) {
    const listStr = topShows
      .map((s, i) => `${i + 1}. ${s.title} (${Math.round(s.criticScore!.score)}/100)`)
      .join(', ');
    faqs.push({
      question: `What are the ${pageTitle.toLowerCase()}?`,
      answer: `Based on aggregated critic reviews, the top-rated are: ${listStr}. Scores are based on reviews from major outlets including ${outletNames}.`,
    });
  }

  // Q: How many shows are in this category?
  const openShows = shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming');
  if (openShows.length > 0) {
    faqs.push({
      question: `How many ${pageTitle.toLowerCase().replace('best ', '')} are currently ${marketLabel}?`,
      answer: `There are currently ${openShows.length} ${pageTitle.toLowerCase().replace('best ', '')} playing ${marketLabel}.`,
    });
  }

  // Q: What is the highest rated?
  const topShow = topShows[0];
  if (topShow?.criticScore) {
    faqs.push({
      question: `What is the highest-rated among the ${pageTitle.toLowerCase()}?`,
      answer: `${topShow.title} is the highest-rated with a CriticScore of ${Math.round(topShow.criticScore.score)}/100 based on ${topShow.criticScore.reviewCount} professional reviews.`,
    });
  }

  // Q: Shows closing soon (if relevant)
  const closingShows = shows.filter(s => {
    if (!s.closingDate || s.status !== 'open') return false;
    const closing = new Date(s.closingDate);
    const now = new Date();
    const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return diffDays > 0 && diffDays <= 90;
  });
  if (closingShows.length > 0) {
    const closingStr = closingShows.slice(0, 3).map(s =>
      `${s.title} (closes ${new Date(s.closingDate!).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })})`
    ).join(', ');
    faqs.push({
      question: `Which of these shows are closing soon?`,
      answer: `Shows closing soon: ${closingStr}. See them before they're gone.`,
    });
  }

  // Q: How are these shows ranked? (methodology — E-E-A-T signal)
  faqs.push({
    question: `How are these shows ranked?`,
    answer: `Shows are ranked by CriticScore, an aggregate rating based on professional reviews from 400+ outlets including ${outletNames}. Top-tier outlets carry the most weight. Each show needs at least ${getMarketMinReviews(shows[0]?.category)} reviews to qualify for ranking. Scores are updated weekly.`,
  });

  if (faqs.length === 0) return null;

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}

// Organization Schema - For outlet pages
export function generateOutletSchema(outlet: {
  name: string;
  slug: string;
  reviewCount: number;
  avgScore: number;
  tier: 1 | 2 | 3 | 4;
  logoDomain?: string | null;
  criticCount?: number;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: outlet.name,
    url: `${BASE_URL}/critics/outlets/${outlet.slug}`,
    ...(outlet.logoDomain && {
      logo: {
        '@type': 'ImageObject',
        url: `https://www.google.com/s2/favicons?domain=${outlet.logoDomain}&sz=128`,
      },
    }),
    description: `${outlet.name} has published ${outlet.reviewCount} Broadway reviews with an average score of ${outlet.avgScore}/100. Tier ${outlet.tier} publication.`,
    knowsAbout: 'Broadway Theater Reviews',
    // Note: AggregateRating is not valid on Organization per Google's structured data spec.
    // Only supported on Product, Recipe, LocalBusiness, etc. Removed to avoid GSC warnings.
    ...(outlet.criticCount && { numberOfEmployees: outlet.criticCount }),
  };
}

// Person Schema - For critic pages
export function generateCriticSchema(critic: {
  name: string;
  slug: string;
  primaryOutlet: string;
  reviewCount: number;
  avgScore: number;
  outlets?: string[];
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: critic.name,
    url: `${BASE_URL}/critics/${critic.slug}`,
    jobTitle: 'Theater Critic',
    knowsAbout: 'Broadway Theater',
    worksFor: critic.outlets && critic.outlets.length > 1
      ? critic.outlets.map(o => ({ '@type': 'Organization' as const, name: o }))
      : { '@type': 'Organization', name: critic.primaryOutlet },
    description: `${critic.name} is a Broadway theater critic at ${critic.primaryOutlet} with ${critic.reviewCount} reviews and an average score of ${critic.avgScore}/100.`,
    // Note: AggregateRating is not valid on Person per Google's structured data spec.
    // Only supported on Product, Recipe, LocalBusiness, etc. Removed to avoid GSC warnings.
  };
}

// ItemList Schema - For critic/outlet index pages
export function generateCriticItemListSchema(critics: {
  name: string;
  slug: string;
  primaryOutlet: string;
  reviewCount: number;
  avgScore: number;
}[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Broadway Theater Critics',
    numberOfItems: critics.length,
    itemListElement: critics.slice(0, 50).map((critic, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Person',
        name: critic.name,
        url: `${BASE_URL}/critics/${critic.slug}`,
        jobTitle: 'Theater Critic',
        worksFor: { '@type': 'Organization', name: critic.primaryOutlet },
      },
    })),
  };
}

export function generateOutletItemListSchema(outlets: {
  name: string;
  slug: string;
  reviewCount: number;
  tier: 1 | 2 | 3 | 4;
}[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Broadway Review Publications',
    numberOfItems: outlets.length,
    itemListElement: outlets.slice(0, 50).map((outlet, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Organization',
        name: outlet.name,
        url: `${BASE_URL}/critics/outlets/${outlet.slug}`,
      },
    })),
  };
}

// FAQ Schema - For critic detail pages
export function generateCriticFAQSchema(critic: {
  name: string;
  primaryOutlet: string;
  outlets: string[];
  reviewCount: number;
  avgScore: number;
  highScore: number;
  lowScore: number;
  isFreelancer: boolean;
}) {
  const faqs: { question: string; answer: string }[] = [];

  faqs.push({
    question: `How many shows has ${critic.name} reviewed?`,
    answer: `${critic.name} has reviewed ${critic.reviewCount} shows on Broadway Scorecard, with an average score of ${critic.avgScore}/100.`,
  });

  faqs.push({
    question: `What outlet does ${critic.name} write for?`,
    answer: critic.outlets.length > 1
      ? `${critic.name} writes for ${critic.outlets.join(', ')}. Their primary outlet is ${critic.primaryOutlet}.${critic.isFreelancer ? ` ${critic.name} is a freelance critic.` : ''}`
      : `${critic.name} writes for ${critic.primaryOutlet}.`,
  });

  faqs.push({
    question: `What is ${critic.name}'s highest and lowest score?`,
    answer: `${critic.name}'s highest score is ${critic.highScore}/100 and lowest score is ${critic.lowScore}/100, with an average of ${critic.avgScore}/100.`,
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

// FAQ Schema - For outlet detail pages
export function generateOutletFAQSchema(outlet: {
  name: string;
  tier: 1 | 2 | 3 | 4;
  reviewCount: number;
  avgScore: number;
  criticCount: number;
  highScore: number;
  lowScore: number;
}) {
  const tierLabel = outlet.tier === 1 ? 'Tier 1 (highest weight)'
    : outlet.tier === 2 ? 'Tier 2'
    : outlet.tier === 4 ? 'Tier 4'
    : 'Tier 3';
  const faqs: { question: string; answer: string }[] = [];

  faqs.push({
    question: `How many reviews has ${outlet.name} published?`,
    answer: `${outlet.name} has published ${outlet.reviewCount} reviews on Broadway Scorecard, with an average score of ${outlet.avgScore}/100.`,
  });

  faqs.push({
    question: `What tier is ${outlet.name} on Broadway Scorecard?`,
    answer: `${outlet.name} is classified as ${tierLabel}. Tier 1 outlets (like The New York Times and Variety) carry the highest weight in composite scores.`,
  });

  faqs.push({
    question: `How many critics write for ${outlet.name}?`,
    answer: `${outlet.criticCount} different critic${outlet.criticCount !== 1 ? 's' : ''} have published Broadway reviews through ${outlet.name}.`,
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

// FAQ Schema - For Gold List pages
export function generateGoldListFAQSchema(config: {
  title: string;
  type: string;
  description: string;
  metricLabel: string;
  threshold: number;
  metricSuffix: string;
  maxPerSeason: number;
  maxAllTime: number;
  minDataRequirement: string;
}, context: {
  season?: string;
  entryCount: number;
  topShow?: string;
}) {
  const faqs: { question: string; answer: string }[] = [];
  const scope = context.season ? `the ${context.season} season` : 'all time';

  faqs.push({
    question: `What is the ${config.title}?`,
    answer: `${config.description}. Shows must have ${config.minDataRequirement} to qualify.${config.threshold > 0 ? ` The minimum ${config.metricLabel.toLowerCase()} is ${config.threshold}${config.metricSuffix}.` : ''}`,
  });

  faqs.push({
    question: `How many shows are on the ${config.title} for ${scope}?`,
    answer: `There are ${context.entryCount} shows on the ${config.title} for ${scope}.${context.topShow ? ` The #1 show is ${context.topShow}.` : ''}`,
  });

  const maxLabel = context.season ? config.maxPerSeason : config.maxAllTime;
  faqs.push({
    question: `How are shows ranked on the ${config.title}?`,
    answer: `Shows are ranked by ${config.metricLabel.toLowerCase()}, with a maximum of ${maxLabel} shows${context.season ? ' per season' : ' across all seasons since 2005'}. ${config.minDataRequirement} is required to qualify.`,
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}


// Person Schema - For unified creative team pages (/creative/[slug])
export function generateUnifiedCreativePersonSchema(profile: {
  name: string;
  slug: string;
  showCount: number;
  scoredShowCount: number;
  avgScore: number | null;
  shows: Array<{ title: string; slug: string }>;
}, categoryLabels: string[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.name,
    url: `${BASE_URL}/creative/${profile.slug}`,
    jobTitle: categoryLabels,
    knowsAbout: 'Broadway Theater',
    description: `${profile.name} is a Broadway ${categoryLabels.join(', ').toLowerCase()} with ${profile.showCount} show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null && profile.scoredShowCount >= 3 ? ` and an average critic score of ${profile.avgScore}/100` : ''}.`,
    // Note: AggregateRating is not valid on Person per Google's structured data spec.
    // Only supported on Product, Recipe, LocalBusiness, etc. Removed to avoid GSC warnings.
    // Mirrors the same fix already applied to generateOutletSchema and generateCriticSchema.
  };
}

// FAQ Schema - For unified creative team pages
export function generateUnifiedCreativeFAQSchema(profile: {
  name: string;
  showCount: number;
  scoredShowCount: number;
  avgScore: number | null;
  highScore: number | null;
  openShowCount: number;
  shows: Array<{ title: string; score: number | null; status: string }>;
}, categoryLabels: string[]) {
  const rolesText = categoryLabels.join(', ').toLowerCase();
  const faqs: { question: string; answer: string }[] = [];

  faqs.push({
    question: `How many shows has ${profile.name} worked on?`,
    answer: `${profile.name} has worked on ${profile.showCount} show${profile.showCount !== 1 ? 's' : ''} as a ${rolesText}${profile.avgScore !== null && profile.scoredShowCount >= 3 ? `, with an average critic score of ${profile.avgScore}/100` : ''}.`,
  });

  if (profile.highScore !== null) {
    const best = profile.shows.filter(s => s.score !== null).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    if (best) {
      faqs.push({
        question: `What is ${profile.name}'s highest-rated show?`,
        answer: `${profile.name}'s highest-rated show is ${best.title} with a critic score of ${best.score}/100.`,
      });
    }
  }

  if (profile.openShowCount > 0) {
    const running = profile.shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming');
    faqs.push({
      question: `Does ${profile.name} have any shows currently running?`,
      answer: `Yes, ${profile.name} currently has ${running.length} show${running.length !== 1 ? 's' : ''} running: ${running.map(s => s.title).join(', ')}.`,
    });
  } else {
    faqs.push({
      question: `Does ${profile.name} have any shows currently running?`,
      answer: `No, ${profile.name} does not currently have any shows running.`,
    });
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

// ============================================
// Actor Profile Schemas
// ============================================

export function generateActorPersonSchema(profile: {
  name: string;
  slug: string;
  showCount: number;
  avgScore: number | null;
  ibdbPersonId: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.name,
    url: `${BASE_URL}/cast/${profile.slug}`,
    jobTitle: 'Theatre Actor',
    knowsAbout: 'Theatre',
    description: `${profile.name} is a theatre actor who has appeared in ${profile.showCount} show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null ? ` with an average critic score of ${profile.avgScore}/100` : ''}.`,
    sameAs: [`https://www.ibdb.com/broadway-cast-staff/${profile.ibdbPersonId}`],
  };
}

export function generateActorFAQSchema(profile: {
  name: string;
  showCount: number;
  avgScore: number | null;
  highScore: { score: number; showTitle: string } | null;
  openShowCount: number;
  shows: Array<{ title: string; score: number | null; status: string; castType?: string }>;
}) {
  const faqs: { question: string; answer: string }[] = [];

  faqs.push({
    question: `How many shows has ${profile.name} appeared in?`,
    answer: `${profile.name} has appeared in ${profile.showCount} show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null ? `, with an average critic score of ${profile.avgScore}/100` : ''}.`,
  });

  if (profile.highScore) {
    faqs.push({
      question: `What is ${profile.name}'s highest-rated show?`,
      answer: `${profile.name}'s highest-rated show is ${profile.highScore.showTitle} with a critic score of ${profile.highScore.score}/100.`,
    });
  }

  // Only claim actor is currently on Broadway if they're in the current cast
  const currentlyIn = profile.shows.filter(s =>
    (s.status === 'open' || s.status === 'previews' || s.status === 'upcoming') && s.castType === 'current'
  );
  if (currentlyIn.length > 0) {
    faqs.push({
      question: `Is ${profile.name} currently in a show?`,
      answer: `Yes, ${profile.name} is currently appearing in ${currentlyIn.map(s => s.title).join(', ')}.`,
    });
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

// FAQPage Schema - For homepage
export function generateHomepageFAQSchema(stats: { totalShows: number; totalReviews: number }) {
  const faqs = [
    {
      question: 'What is Broadway Scorecard?',
      answer: `Broadway Scorecard aggregates critic reviews from over 400 outlets to create a single CriticScore (0-100) for every Broadway show. We currently track ${stats.totalShows.toLocaleString()} shows and ${stats.totalReviews.toLocaleString()} reviews.`,
    },
    {
      question: 'How are Broadway show scores calculated?',
      answer: 'Each show gets a CriticScore from 0-100 based on a tier-weighted average of professional reviews. Tier 1 outlets (The New York Times, Vulture, Variety, Guardian) carry full weight (1.0). Tier 2 outlets (NY Post, TheaterMania, BroadwayWorld, Times UK) carry 0.75 weight. Tier 3 outlets carry 0.40 weight. Tier 4 (unverified single-author blogs) carry 0.20 weight. Tiers are per-region: NYT is Tier 1 for Broadway and Tier 2 for West End. Shows need a minimum number of reviews to display a score.',
    },
    {
      question: 'What are the best Broadway shows right now?',
      answer: 'Visit our Best Broadway Shows page or browse by category (musicals, plays, comedies, revivals) to see the highest-rated shows currently playing. Scores update daily as new reviews are published.',
    },
    {
      question: 'How is Broadway Scorecard different from other review sites?',
      answer: 'Unlike sites that show individual reviews, Broadway Scorecard aggregates scores from every major critic into one transparent number. We weight reviews by outlet tier and show you exactly how the score is calculated, including individual critic scores from The New York Times, Vulture, Variety, and hundreds more.',
    },
  ];

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

