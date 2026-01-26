// SEO Utilities - Structured Data Schemas for Rich Search Results

import { ComputedShow } from './engine';

export const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// Organization Schema - Site identity
export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Broadway Scorecard',
    url: BASE_URL,
    logo: `${BASE_URL}/logo.png`,
    description: 'Aggregated Broadway show ratings from professional critics',
    sameAs: [
      // Add social profiles when available
    ],
  };
}

// WebSite Schema - For sitelinks search box
export function generateWebSiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Broadway Scorecard',
    url: BASE_URL,
    description: 'Comprehensive Broadway show ratings combining critic reviews, audience scores, and community buzz.',
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
      score: review.assignedScore,
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

// FAQPage Schema - For show pages and other FAQ content
// FAQ schema increases AI citations by 28% and makes pages 3.2x more likely to appear in AI Overviews
export function generateShowFAQSchema(show: ComputedShow) {
  const score = show.criticScore?.score ? Math.round(show.criticScore.score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;

  const faqs: { question: string; answer: string }[] = [];

  // Q: What is the score?
  if (score && reviewCount >= 5) {
    faqs.push({
      question: `What is the critic score for ${show.title}?`,
      answer: `${show.title} has a critic score of ${score}/100 based on ${reviewCount} professional reviews. ${
        score >= 85 ? 'This is considered a "Must-See" show.' :
        score >= 75 ? 'This is a "Recommended" show.' :
        score >= 65 ? 'This is rated "Worth Seeing".' :
        score >= 55 ? 'This show is rated "Skippable".' :
        'Critics generally did not recommend this show.'
      }`,
    });
  }

  // Q: Is it still running?
  faqs.push({
    question: `Is ${show.title} still running on Broadway?`,
    answer: show.status === 'open'
      ? `Yes, ${show.title} is currently playing at ${show.venue} on Broadway.${show.closingDate ? ` It is scheduled to close on ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.` : ''}`
      : show.status === 'previews'
      ? `${show.title} is currently in previews at ${show.venue}. It officially opens on ${new Date(show.openingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
      : `No, ${show.title} has closed. It played at ${show.venue}${show.closingDate ? ` and closed on ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}.`,
  });

  // Q: Where is it playing?
  if (show.status !== 'closed') {
    faqs.push({
      question: `Where is ${show.title} playing on Broadway?`,
      answer: `${show.title} is playing at ${show.venue}${show.theaterAddress ? `, located at ${show.theaterAddress}` : ''}.`,
    });
  }

  // Q: How long is it?
  if (show.runtime) {
    const runtimeMins = parseInt(show.runtime, 10);
    if (!isNaN(runtimeMins)) {
      const hours = Math.floor(runtimeMins / 60);
      const mins = runtimeMins % 60;
      const runtimeStr = hours > 0
        ? `${hours} hour${hours > 1 ? 's' : ''}${mins > 0 ? ` and ${mins} minutes` : ''}`
        : `${mins} minutes`;
      faqs.push({
        question: `How long is ${show.title}?`,
        answer: `${show.title} has a runtime of ${runtimeStr}${show.intermissions ? `, including ${show.intermissions} intermission${show.intermissions > 1 ? 's' : ''}` : ' with no intermission'}.`,
      });
    }
  }

  // Q: Who's in the cast?
  if (show.cast && show.cast.length > 0) {
    const topCast = show.cast.slice(0, 5);
    faqs.push({
      question: `Who is in the cast of ${show.title}?`,
      answer: `The cast of ${show.title} includes ${topCast.map(c => `${c.name}${c.role ? ` (${c.role})` : ''}`).join(', ')}${show.cast.length > 5 ? `, and ${show.cast.length - 5} more` : ''}.`,
    });
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

// Helper to render schema as JSON-LD script
export function schemaToJsonLd(schema: Record<string, unknown> | Record<string, unknown>[]) {
  return JSON.stringify(schema);
}
