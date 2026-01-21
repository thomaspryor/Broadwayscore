// SEO Utilities - Structured Data Schemas for Rich Search Results

import { ComputedShow } from './engine';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

// Organization Schema - Site identity
export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'BroadwayMetaScores',
    url: BASE_URL,
    logo: `${BASE_URL}/logo.png`,
    description: 'Aggregated Broadway show ratings from professional critics',
    sameAs: [
      // Add social profiles when available
    ],
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

// Review Schema - Individual critic review
export function generateReviewSchema(review: {
  outlet: string;
  criticName?: string;
  score: number;
  url: string;
  publishDate: string;
  excerpt?: string;
}) {
  return {
    '@type': 'Review',
    author: {
      '@type': review.criticName ? 'Person' : 'Organization',
      name: review.criticName || review.outlet,
    },
    publisher: {
      '@type': 'Organization',
      name: review.outlet,
    },
    datePublished: review.publishDate,
    reviewRating: {
      '@type': 'Rating',
      ratingValue: review.score,
      bestRating: 100,
      worstRating: 0,
    },
    url: review.url,
    ...(review.excerpt && { reviewBody: review.excerpt }),
  };
}

// TheaterEvent Schema with full details (enhanced)
export function generateShowSchema(show: ComputedShow) {
  const reviews = show.criticScore?.reviews || [];

  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TheaterEvent',
    name: show.title,
    description: show.synopsis,
    url: `${BASE_URL}/show/${show.slug}`,
    location: {
      '@type': 'PerformingArtsTheater',
      name: show.venue,
      address: show.theaterAddress || show.venue,
    },
    startDate: show.openingDate,
    ...(show.closingDate && { endDate: show.closingDate }),
    ...(show.images?.hero && { image: show.images.hero }),
    eventStatus: show.status === 'open' ? 'https://schema.org/EventScheduled' : 'https://schema.org/EventCancelled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  };

  // Add aggregate rating if we have scores
  if (show.criticScore?.score) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Math.round(show.criticScore.score),
      bestRating: 100,
      worstRating: 0,
      reviewCount: show.criticScore.reviewCount,
    };
  }

  // Add individual reviews
  if (reviews.length > 0) {
    schema.review = reviews.slice(0, 10).map(review => generateReviewSchema({
      outlet: review.outlet,
      criticName: review.criticName,
      score: review.mappedScore,
      url: review.url,
      publishDate: review.publishDate,
      excerpt: review.quote,
    }));
  }

  // Add ticket offers
  if (show.ticketLinks && show.ticketLinks.length > 0) {
    schema.offers = show.ticketLinks.map(link => ({
      '@type': 'Offer',
      url: link.url,
      priceCurrency: 'USD',
      price: link.priceFrom,
      availability: 'https://schema.org/InStock',
      seller: {
        '@type': 'Organization',
        name: link.platform,
      },
    }));
  }

  // Add performers (cast)
  if (show.cast && show.cast.length > 0) {
    schema.performer = show.cast.map(member => ({
      '@type': 'Person',
      name: member.name,
    }));
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

  return schema;
}

// Person Schema - For director pages
export function generatePersonSchema(person: {
  name: string;
  slug: string;
  role: string;
  shows: { title: string; slug: string; score?: number }[];
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: person.name,
    url: `${BASE_URL}/director/${person.slug}`,
    jobTitle: person.role,
    knowsAbout: 'Theater Direction',
    workExample: person.shows.map(show => ({
      '@type': 'TheaterEvent',
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
    })),
  };
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
    ...(theater.address && { address: theater.address }),
    event: theater.currentShow ? {
      '@type': 'TheaterEvent',
      name: theater.currentShow.title,
      url: `${BASE_URL}/show/${theater.currentShow.slug}`,
    } : undefined,
  };
}

// ItemList Schema - For best-of pages
export function generateItemListSchema(items: {
  name: string;
  url: string;
  image?: string;
  score?: number;
}[], listName: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: listName,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'TheaterEvent',
        name: item.name,
        url: item.url,
        ...(item.image && { image: item.image }),
        ...(item.score && {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: item.score,
            bestRating: 100,
            worstRating: 0,
          },
        }),
      },
    })),
  };
}

// Helper to render schema as JSON-LD script
export function schemaToJsonLd(schema: Record<string, unknown> | Record<string, unknown>[]) {
  return JSON.stringify(schema);
}
