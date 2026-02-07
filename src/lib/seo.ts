// SEO Utilities - Structured Data Schemas for Rich Search Results

import { ComputedShow } from './engine';

export const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

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
    logo: `${BASE_URL}/logo.png`,
    description: 'Aggregated Broadway show ratings from professional critics',
    inLanguage: 'en',
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
    inLanguage: 'en',
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
      ratingValue: toFiveStarScale(review.score),
      bestRating: 5,
      worstRating: 1,
    },
    url: review.url,
    ...(review.excerpt && { reviewBody: review.excerpt }),
  };
}

// TheaterEvent Schema with full details (enhanced)
export function generateShowSchema(show: ComputedShow, lastUpdated?: string) {
  const reviews = show.criticScore?.reviews || [];

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
      address: show.theaterAddress || show.venue,
    },
    startDate: show.openingDate,
    ...(show.closingDate && { endDate: show.closingDate }),
    ...(show.images?.hero && { image: show.images.hero }),
    ...(lastUpdated && { dateModified: lastUpdated }),
    eventStatus: show.status === 'closed' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    organizer: {
      '@type': 'Organization',
      name: 'Broadway Scorecard',
      url: BASE_URL,
    },
  };

  // Add aggregate rating if we have scores and reviewCount
  // Uses 1-5 star scale for Google rich snippet compatibility
  if (show.criticScore?.score && show.criticScore?.reviewCount) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: toFiveStarScale(show.criticScore.score),
      bestRating: 5,
      worstRating: 1,
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
        ...(item.image && { image: item.image }),
        ...(item.description && { description: item.description }),
      };

      // Location (required for TheaterEvent)
      if (item.venue) {
        event.location = {
          '@type': 'PerformingArtsTheater',
          name: item.venue,
          address: item.theaterAddress || item.venue,
        };
      }

      // Dates
      if (item.startDate) {
        event.startDate = item.startDate;
      }
      if (item.endDate) {
        event.endDate = item.endDate;
      }

      // Event status
      if (item.status) {
        event.eventStatus = item.status === 'open' || item.status === 'previews'
          ? 'https://schema.org/EventScheduled'
          : 'https://schema.org/EventCancelled';
        event.eventAttendanceMode = 'https://schema.org/OfflineEventAttendanceMode';
      }

      // Organizer
      event.organizer = {
        '@type': 'Organization',
        name: 'Broadway Scorecard',
        url: BASE_URL,
      };

      // Aggregate rating (with required reviewCount)
      // Uses 1-5 star scale for Google rich snippet compatibility
      if (item.score && item.reviewCount) {
        event.aggregateRating = {
          '@type': 'AggregateRating',
          ratingValue: toFiveStarScale(item.score),
          bestRating: 5,
          worstRating: 1,
          reviewCount: item.reviewCount,
        };
      }

      // Ticket offers
      if (item.ticketLinks && item.ticketLinks.length > 0) {
        event.offers = item.ticketLinks.map(link => ({
          '@type': 'Offer',
          url: link.url,
          priceCurrency: 'USD',
          ...(link.priceFrom && { price: link.priceFrom }),
          availability: 'https://schema.org/InStock',
          seller: {
            '@type': 'Organization',
            name: link.platform,
          },
        }));
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
  shows: { title: string; slug: string; venue?: string; criticScore?: { score: number; reviewCount: number } | null; status?: string; closingDate?: string | null; type?: string }[],
) {
  if (shows.length === 0) return null;

  const faqs: { question: string; answer: string }[] = [];

  // Q: What are the best shows in this category?
  const topShows = shows
    .filter(s => s.criticScore?.score && s.criticScore.reviewCount >= 5)
    .slice(0, 5);

  if (topShows.length >= 2) {
    const listStr = topShows
      .map((s, i) => `${i + 1}. ${s.title} (${Math.round(s.criticScore!.score)}/100)`)
      .join(', ');
    faqs.push({
      question: `What are the ${pageTitle.toLowerCase()}?`,
      answer: `Based on aggregated critic reviews, the top-rated are: ${listStr}. Scores are based on reviews from major outlets including The New York Times, Vulture, and Variety.`,
    });
  }

  // Q: How many shows are in this category?
  const openShows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  if (openShows.length > 0) {
    faqs.push({
      question: `How many ${pageTitle.toLowerCase().replace('best ', '')} are currently on Broadway?`,
      answer: `There are currently ${openShows.length} ${pageTitle.toLowerCase().replace('best ', '')} playing on Broadway.`,
    });
  }

  // Q: What is the highest rated?
  const topShow = topShows[0];
  if (topShow?.criticScore) {
    faqs.push({
      question: `What is the highest-rated among the ${pageTitle.toLowerCase()}?`,
      answer: `${topShow.title} is the highest-rated with a critic score of ${Math.round(topShow.criticScore.score)}/100 based on ${topShow.criticScore.reviewCount} professional reviews.`,
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
  tier: 1 | 2 | 3;
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
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: toFiveStarScale(outlet.avgScore),
      bestRating: 5,
      worstRating: 1,
      reviewCount: outlet.reviewCount,
    },
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
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: toFiveStarScale(critic.avgScore),
      bestRating: 5,
      worstRating: 1,
      reviewCount: critic.reviewCount,
    },
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
  tier: 1 | 2 | 3;
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
    question: `How many Broadway shows has ${critic.name} reviewed?`,
    answer: `${critic.name} has reviewed ${critic.reviewCount} Broadway shows on Broadway Scorecard, with an average score of ${critic.avgScore}/100.`,
  });

  faqs.push({
    question: `What outlet does ${critic.name} write for?`,
    answer: critic.outlets.length > 1
      ? `${critic.name} writes for ${critic.outlets.join(', ')}. Their primary outlet is ${critic.primaryOutlet}.${critic.isFreelancer ? ` ${critic.name} is a freelance critic.` : ''}`
      : `${critic.name} writes for ${critic.primaryOutlet}.`,
  });

  faqs.push({
    question: `What is ${critic.name}'s highest and lowest Broadway score?`,
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
  tier: 1 | 2 | 3;
  reviewCount: number;
  avgScore: number;
  criticCount: number;
  highScore: number;
  lowScore: number;
}) {
  const tierLabel = outlet.tier === 1 ? 'Tier 1 (highest weight)' : outlet.tier === 2 ? 'Tier 2' : 'Tier 3';
  const faqs: { question: string; answer: string }[] = [];

  faqs.push({
    question: `How many Broadway reviews has ${outlet.name} published?`,
    answer: `${outlet.name} has published ${outlet.reviewCount} Broadway reviews on Broadway Scorecard, with an average score of ${outlet.avgScore}/100.`,
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

// Helper to render schema as JSON-LD script
export function schemaToJsonLd(schema: Record<string, unknown> | Record<string, unknown>[]) {
  return JSON.stringify(schema);
}
