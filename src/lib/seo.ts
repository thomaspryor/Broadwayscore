// SEO Utilities - Structured Data Schemas for Rich Search Results

import { ComputedShow } from './engine';
import { isLondonMarket, getMarketCountry, getMarketCurrency, getMarketMinReviews, getMarketLabel, getUkRegionalVenueCity } from './venue-classification';
import { isOperaShow } from './show-market';
import { getGoldThreshold } from '@/config/score-buckets';
import { getVisibleTicketLinks } from './ticket-utils';
import { SOCIAL_ACCOUNTS, type SocialPlatform } from '@/config/branding';
import { AUTHOR } from '@/config/author';
import { formatShowDate } from './date-utils';
import { shortCity, stopPlace, stopKey, type TourNowNext, type TourStop } from './tour-schedule';
import { isTourScored, isTourScoreHidden } from './tour-listing';
import { displaysCriticScore } from './critic-score-display';

export const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

/**
 * The site's default link-preview image. A page's openGraph replaces the root
 * layout's wholesale, images included, so a page that sets openGraph lists its
 * own images: this one, or the West End or Tony card below (BRO-5529,
 * tests/unit/social-preview-metadata.test.ts).
 */
export const SITE_OG_IMAGE = {
  url: `${BASE_URL}/og/home.png`,
  width: 1200,
  height: 630,
  alt: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
};

/** The West End card, for London pages (/west-end, /off-west-end, /olivier-awards). */
export const WEST_END_OG_IMAGE = {
  url: `${BASE_URL}/og/west-end.png`,
  width: 1200,
  height: 630,
  alt: 'West End Scorecard - Aggregated London Theatre Ratings',
};

/** The Tony Awards card, for /tony-awards and /award-score pages. */
export const TONY_OG_IMAGE = {
  url: `${BASE_URL}/og/tony-awards.png`,
  width: 1200,
  height: 630,
  alt: 'Tony Awards - Broadway Scorecard',
};

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

// Organization Schema - Site identity.
// sameAs links our official profiles to the entity so Google can resolve
// "Broadway Scorecard" as a recognized organization (Knowledge Graph) rather than
// a generic site — the entity-recognition signal review aggregators like
// Metacritic/Rotten Tomatoes carry. Sourced from the single SOCIAL_ACCOUNTS config
// so it never drifts from the footer links.
export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Broadway Scorecard',
    url: BASE_URL,
    logo: `${BASE_URL}/og/home.png`,
    description: 'Aggregated Broadway show ratings from professional critics',
    sameAs: SOCIAL_ACCOUNTS.map(a => a.url),
    inLanguage: 'en',
  };
}

// Person Schema - Author entity for byline consolidation (/reviews/[slug] <-> /about).
// Reuses the same social profiles as the Organization node's sameAs so Google
// resolves "Tom Pryor" and "Broadway Scorecard" as connected entities rather
// than two unrelated names — correct for a one-person site where those accounts
// ARE Tom's voice for the brand. url + a stable @id point at /about, which
// renders this same schema (see /about/page.tsx) so a crawler following the
// byline link lands on a page that re-asserts the identical Person entity —
// completing the byline -> /about -> Person schema consolidation chain.
const AUTHOR_SOCIAL_PLATFORMS: SocialPlatform[] = ['bluesky', 'twitter', 'instagram'];
export const AUTHOR_PERSON_ID = `${BASE_URL}${AUTHOR.url}#person`;

export function generateAuthorPersonSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': AUTHOR_PERSON_ID,
    name: AUTHOR.name,
    url: toAbsoluteUrl(AUTHOR.url),
    jobTitle: AUTHOR.jobTitle,
    worksFor: {
      '@type': 'Organization',
      name: 'Broadway Scorecard',
      url: BASE_URL,
    },
    sameAs: SOCIAL_ACCOUNTS.filter(a => AUTHOR_SOCIAL_PLATFORMS.includes(a.platform)).map(a => a.url),
  };
}

// Parse address string like "226 W 46th St, New York, NY 10036" into PostalAddress.
// country has no default — every caller must resolve it explicitly. A silent
// 'US' default let generateTheaterSchema assert a country it never checked
// (caught in review of #1451: the fallback branch below used to return a bare
// string with no country claim at all; defaulting to 'US' there would have
// turned "no claim" into a false one for any future non-US theater).
/** Market-level stand-in location for a show with no theater yet (Google requires a TheaterEvent location). */
function unannouncedTheater(category: string | undefined, country: string) {
  return {
    '@type': 'PerformingArtsTheater',
    name: category === 'opera' ? 'Metropolitan Opera House' : isLondonMarket(category) ? 'West End Theatre' : category === 'off-broadway' ? 'Off-Broadway Theater' : 'Broadway Theater',
    address: toPostalAddress(isLondonMarket(category) ? 'London, England' : 'New York, NY', country),
  };
}

function toPostalAddress(address: string, country: string) {
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
  // Non-US formats (UK postcodes, etc.) don't match the strict US regex above.
  // Returning the bare string here used to silently drop addressCountry from
  // the schema entirely (#1437, #1451) — fall back to a minimal PostalAddress
  // that still carries the country the caller already resolved, rather than
  // parsing every country's street-address format.
  return {
    '@type': 'PostalAddress',
    streetAddress: address,
    addressCountry: country,
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

/**
 * eventStatus for a run: EventScheduled only while it is still running.
 * schema.org has no "ended" value, so a closed run (or one whose endDate has
 * passed) omits the field rather than claim it is scheduled (BRO-5967).
 */
export function eventStatusField(status?: string, endDate?: string | null, today = new Date().toISOString().slice(0, 10)) {
  if (status === 'closed' || (endDate && endDate < today)) return {};
  return { eventStatus: 'https://schema.org/EventScheduled' };
}

// TheaterEvent Schema with full details (enhanced)
/** Upcoming engagements emitted as subEvents of a tour's TheaterEvent. */
const TOUR_SUB_EVENTS_MAX = 10;

/**
 * A national tour's upcoming stops as TheaterEvents, each at its real theater
 * (BRO-4601). The tour-level event keeps the aggregateRating; stops carry no Offer
 * (we have no price for them, and Google requires one, BRO-5967).
 */
export function tourSubEvents(
  show: Pick<ComputedShow, 'title' | 'slug' | 'images'>,
  stops: TourStop[],
  today: string,
  tickets: Record<string, string> = {},
) {
  return stops.filter(s => s.end >= today).slice(0, TOUR_SUB_EVENTS_MAX).map(s => {
    const place = stopPlace(s.city);
    return {
      '@type': 'TheaterEvent',
      name: `${show.title} in ${shortCity(s.city)}`,
      url: `${BASE_URL}/show/${show.slug}#tour-schedule`,
      startDate: s.start,
      endDate: s.end,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: {
        '@type': 'PerformingArtsTheater',
        name: s.venue,
        address: {
          '@type': 'PostalAddress',
          addressLocality: place.locality,
          ...(place.region && { addressRegion: place.region }),
          addressCountry: place.country,
        },
      },
      ...(show.images?.hero && { image: toAbsoluteUrl(show.images.hero) }),
    };
  });
}

export function generateShowSchema(show: ComputedShow, lastUpdated?: string, performers?: { name: string }[], organizerUrl?: string, tour?: { stops: TourStop[]; today: string; tickets?: Record<string, string> }) {
  const isLondon = isLondonMarket(show.category);
  const country = getMarketCountry(show.category, show.venue);
  const currency = getMarketCurrency(show.category, show.venue);
  // Event spec requires startDate. Fall back to previewsStartDate when openingDate
  // isn't yet announced.
  const startDate = show.openingDate || show.previewsStartDate;
  // A national tour (BRO-4211) has no single theater: "North American Tour" is
  // not a PerformingArtsTheater or a postal address, and no venue presents it.
  const isTour = show.category === 'tour';
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TheaterEvent',
    name: show.title,
    description: show.synopsis,
    url: `${BASE_URL}/show/${show.slug}`,
    inLanguage: 'en',
    // An announced show with no theater yet gets the market stand-in, as the
    // list schema does (toPostalAddress(null) crashed its page, BRO-5808).
    location: isTour
      ? { '@type': 'Place', name: show.venue, address: { '@type': 'PostalAddress', addressCountry: country } }
      : show.venue
        ? {
            '@type': 'PerformingArtsTheater',
            name: show.venue,
            address: toPostalAddress(show.theaterAddress || show.venue, country),
          }
        : unannouncedTheater(show.category, country),
    // GSC flags Events missing "organizer". We don't track producers, so the
    // presenting theater is the closest honest entity we always have.
    // organizerUrl (our /theater/{slug} entity page, Broadway-only) clears the
    // follow-up "Missing field 'url' (in 'organizer')" GSC warning.
    ...(!isTour && show.venue && {
      organizer: {
        '@type': 'Organization',
        name: show.venue,
        ...(organizerUrl && { url: organizerUrl }),
      },
    }),
    ...(startDate && { startDate }),
    ...(show.closingDate && { endDate: show.closingDate }),
    ...(show.images?.hero && { image: toAbsoluteUrl(show.images.hero) }),
    ...(lastUpdated && { dateModified: lastUpdated }),
    ...eventStatusField(show.status, show.closingDate),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    // @id keeps this entity referenceable within the page's @graph.
    '@id': `${BASE_URL}/show/${show.slug}#event`,
  };
  if (isTour && tour && show.status !== 'closed') {
    const subEvent = tourSubEvents(show, tour.stops, tour.today, tour.tickets);
    if (subEvent.length) schema.subEvent = subEvent;
  }

  // Add aggregate rating if we have scores and sufficient reviews
  // Uses 1-5 star scale for Google rich snippet compatibility
  // A tour follows the page's own TBD rule (isTourScoreHidden: +2 reviews with
  // no T1/T2, no rating in previews or upcoming, the coverage floor), so an
  // indexed tour never claims a rating its page hides.
  // Same review-count gate as the page's badge (displaysCriticScore, BRO-4312).
  if (show.criticScore?.score && displaysCriticScore(show) && (!isTour || !isTourScoreHidden(show))) {
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
    const visibleLinks = getVisibleTicketLinks(show.ticketLinks);
    // We don't track on-sale dates; by previews start tickets are certainly on
    // sale, so previewsStartDate is the latest-safe validFrom (GSC warns
    // per-offer without it). Only claim it once the date has PASSED at build
    // time — a future validFrom contradicts availability:InStock for upcoming
    // shows (tickets are usually on sale long before previews). Pages rebuild
    // on every deploy, so the build-date comparison self-heals. Price stays
    // conditional — most platforms lack priceFrom and inventing one would be
    // fabricated data.
    const onSaleCandidate = show.previewsStartDate || show.openingDate;
    const onSaleBy = onSaleCandidate && onSaleCandidate <= new Date().toISOString().slice(0, 10)
      ? onSaleCandidate
      : undefined;
    if (visibleLinks.some(link => link.priceFrom)) {
      schema.offers = visibleLinks.filter(link => link.priceFrom).map(link => ({
        '@type': 'Offer',
        url: link.url,
        priceCurrency: currency,
        price: link.priceFrom,
        ...(onSaleBy && { validFrom: onSaleBy }),
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

// Per-critic Review nodes are intentionally not emitted (BRO-5967): Google's
// review-snippet policy bars aggregating other sites' reviews, and our per-critic
// ratings are site-assigned conversions, not ratings the critic gave.

// PerformingArtsTheater Schema - For theater pages.
// /theater/[slug] (the only caller) draws theaters exclusively from
// getAllTheaters() -> getBroadwayShows() (src/lib/data-core.ts), so 'US' is
// factually correct for every theater this renders today. Hardcoded rather
// than defaulted so a future non-Broadway theater source has to touch this
// line instead of silently inheriting an unverified country.
export function generateTheaterSchema(theater: {
  name: string;
  slug: string;
  address?: string;
  currentShow?: { title: string; slug: string };
  pastShows: { title: string; slug: string }[];
}) {
  const country = 'US';
  return {
    '@context': 'https://schema.org',
    '@type': 'PerformingArtsTheater',
    name: theater.name,
    url: `${BASE_URL}/theater/${theater.slug}`,
    ...(theater.address && { address: toPostalAddress(theater.address, country) }),
    // Event.location requires an address per Google's structured data spec
    // (GSC flags "Missing field 'address' (in 'location')" otherwise). Venues
    // without a known address (e.g. a not-yet-announced "TBA" house) omit the
    // event entirely rather than emit an incomplete TheaterEvent.
    event: (theater.currentShow && theater.address) ? {
      '@type': 'TheaterEvent',
      name: theater.currentShow.title,
      url: `${BASE_URL}/show/${theater.currentShow.slug}`,
      location: {
        '@type': 'PerformingArtsTheater',
        name: theater.name,
        address: toPostalAddress(theater.address, country),
      },
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    } : undefined,
  };
}

// ItemList Schema - For show lists and explicitly typed people indexes
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
}[], listName: string, itemType: 'TheaterEvent' | 'Person' = 'TheaterEvent') {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: listName,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => {
      if (itemType === 'Person') {
        return {
          '@type': 'ListItem',
          position: index + 1,
          item: { '@type': 'Person', name: item.name, url: item.url },
        };
      }
      // A national tour has no single house or dates to state here ("North
      // American Tour" is not an address): list its page by URL only; the tour
      // page itself carries the event data (BRO-4601 SEO).
      if (item.category === 'tour') {
        return { '@type': 'ListItem', position: index + 1, name: item.name, url: item.url };
      }
      const event: Record<string, unknown> = {
        '@type': 'TheaterEvent',
        name: item.name,
        url: item.url,
        ...(item.image && { image: toAbsoluteUrl(item.image) }),
        ...(item.description && { description: item.description }),
      };

      // Location (required for TheaterEvent per Google structured data)
      const itemCountry = getMarketCountry(item.category, item.venue);
      const ukRegionalCity = getUkRegionalVenueCity(item.category, item.venue);
      event.location = item.venue ? {
        '@type': 'PerformingArtsTheater',
        name: item.venue,
        address: item.theaterAddress
          ? toPostalAddress(item.theaterAddress, itemCountry)
          // No theaterAddress: a bare venue name isn't a claim about country, but a UK
          // regional venue (RSC, Chichester) needs its city/country made explicit —
          // otherwise it falls through to the New York/US default below (#1437).
          : ukRegionalCity ? { '@type': 'PostalAddress', addressLocality: ukRegionalCity, addressCountry: itemCountry } : item.venue,
      } : unannouncedTheater(item.category, itemCountry);

      // Dates
      if (item.startDate) {
        event.startDate = item.startDate;
      }
      if (item.endDate) {
        event.endDate = item.endDate;
      }

      // Event status (required for TheaterEvent per Google structured data)
      Object.assign(event, eventStatusField(item.status, item.endDate));
      event.eventAttendanceMode = 'https://schema.org/OfflineEventAttendanceMode';

      // Organizer
      event.organizer = {
        '@type': 'Organization',
        name: item.category === 'opera' ? 'Opera Scorecard' : isLondonMarket(item.category) ? 'West End Scorecard' : item.category === 'off-broadway' ? 'Off-Broadway Scorecard' : 'Broadway Scorecard',
        url: BASE_URL,
      };

      // No aggregateRating on list items (BRO-5967): Google's review-snippet
      // policy wants ratings about a specific item, not entries in a list.

      // Ticket offers (excluding hidden platforms)
      if (item.ticketLinks && item.ticketLinks.length > 0) {
        const itemCurrency = getMarketCurrency(item.category, item.venue);
        const visibleLinks = getVisibleTicketLinks(item.ticketLinks);
        if (visibleLinks.some(link => link.priceFrom)) {
          event.offers = visibleLinks.filter(link => link.priceFrom).map(link => ({
            '@type': 'Offer',
            url: link.url,
            priceCurrency: itemCurrency,
            price: link.priceFrom,
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
//
// getShowFAQs() builds the raw question/answer list — shared by generateShowFAQSchema()
// (JSON-LD) and the visible PAA-style Q&A block on the show page. Keeping one source of
// truth means the schema always matches what's rendered on-page (Google penalizes FAQ
// schema that doesn't correspond to visible content).
// new Date(null | undefined | '') resolves to the 1970 epoch instead of throwing —
// guards FAQ answer copy from printing "opens on December 31, 1969" for shows
// with an unconfirmed date.
function formatFAQDate(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  // Mirrors formatShowDate's own UTC-midnight parse (slice to the date part,
  // force UTC) so this guard can't disagree with the value it's guarding.
  // The prior `new Date(dateStr).getFullYear()` read the LOCAL year, so on a
  // non-UTC machine a date of exactly 1950-01-01 parsed as UTC midnight would
  // read back as Dec 31 1949 local and get wrongly suppressed by this guard —
  // the same class of bug this whole fix (BRO-3047) exists to close, just
  // hiding inside the validity check instead of the render call.
  const date = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (isNaN(date.getTime()) || date.getUTCFullYear() < 1950) return null;
  return formatShowDate(dateStr, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * `tour` is the national tour's current and next engagement (data passed in,
 * this module imports no data files). ShowFAQSection and the FAQ schema must
 * get the same value so the two stay 1:1.
 */
export function getShowFAQs(show: ComputedShow, consensusText?: string | null, tour?: TourNowNext | null): { question: string; answer: string }[] {
  const score = show.criticScore?.score ? Math.round(show.criticScore.score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;
  const isLondon = isLondonMarket(show.category);
  const isOffBroadway = show.category === 'off-broadway';
  const isRegional = show.category === 'regional';
  const isTour = show.category === 'tour';
  const isOpera = isOperaShow(show);
  // A UK flagship show (RSC, Chichester, ...) is not a Broadway tryout (BRO-5103).
  const regionalLabel = getUkRegionalVenueCity(show.category, show.venue) ? 'in the UK' : 'in a regional production';
  const marketLabel = isOpera ? 'at the Met' : isLondon ? 'in London' : isOffBroadway ? 'Off-Broadway' : isRegional ? regionalLabel : isTour ? 'on tour' : 'on Broadway';

  const faqs: { question: string; answer: string }[] = [];

  const scoreDisplayed = displaysCriticScore(show);

  // Q: What do critics say? — the exact review-intent query ("[show] reviews").
  // Surfaces our unique consensus prose into the FAQ/People-Also-Ask slot, which is
  // where an aggregator can win SERP real estate even when outlet pages outrank the
  // blue link. Falls back to a score-derived summary when no consensus exists yet.
  if (score && scoreDisplayed) {
    const consensusAnswer = consensusText && consensusText.trim().length > 0
      ? `${consensusText.trim()} (CriticScore ${score}/100 from ${reviewCount} reviews.)`
      : `Critics give ${show.title} a CriticScore of ${score}/100 based on ${reviewCount} professional reviews aggregated from leading theater critics.`;
    faqs.push({
      question: `What do critics say about ${show.title}?`,
      answer: consensusAnswer,
    });
  }

  // Q: Is it worth seeing? (highest-intent query — placed first for AI Overview targeting)
  if (score && scoreDisplayed) {
    const goldMin = getGoldThreshold(show.category);
    const worthSeeingAnswer =
      score >= goldMin
        ? isTour
          ? `Absolutely: the ${show.title} national tour is one of the best-reviewed tours on the road, earning ${score}/100 from ${reviewCount} critics in the cities it has played.`
          : `Absolutely: ${show.title} is one of the season's most acclaimed shows, earning a rare ${score}/100 from ${reviewCount} critics. Don't miss it.`
        : score >= 75
        ? `Yes. ${show.title} earns strong reviews from critics (${score}/100 from ${reviewCount} reviews). Most theatergoers will have a great time.`
        : score >= 65
        ? `Probably, if the material interests you. Critics say ${show.title} is worth seeing (${score}/100 from ${reviewCount} reviews): it works best if the premise or cast appeals to you.`
        : score >= 55
        ? `Only if you're a devoted fan. Critics are mixed on ${show.title} (${score}/100 from ${reviewCount} reviews). Most suggest you could skip it.`
        : `Probably not. Critics generally don't recommend ${show.title} (${score}/100 from ${reviewCount} reviews). Save your time and money unless you have a specific reason to go.`;
    faqs.push({
      question: `Is ${show.title} worth seeing?`,
      answer: worthSeeingAnswer,
    });
  }

  // Q: What is the score?
  if (score && scoreDisplayed) {
    const goldMin = getGoldThreshold(show.category);
    faqs.push({
      question: `What is the CriticScore for ${show.title}?`,
      answer: `${show.title} has a CriticScore of ${score}/100 based on ${reviewCount} professional reviews. ${
        score >= goldMin ? 'This is considered a "Critical Gold" show.' :
        score >= 75 ? 'This is a "Recommended" show.' :
        score >= 65 ? 'This is rated "Worth Seeing".' :
        score >= 55 ? 'This show is rated "Mixed".' :
        'Critics generally did not recommend this show.'
      }`,
    });
  }

  // Q: Is it still running?
  // formatFAQDate guards against null/invalid dates (e.g. upcoming shows with no
  // confirmed openingDate yet) — new Date(null) silently resolves to the 1970
  // epoch, which previously rendered as "opens on December 31, 1969" once this
  // copy became visible on-page instead of buried in JSON-LD only.
  const openingDateStr = formatFAQDate(show.openingDate);
  const closingDateStr = formatFAQDate(show.closingDate);
  const previewsStartStr = formatFAQDate(show.previewsStartDate);
  // A tour has no house: its running/where answers come from the schedule
  // (data/tour-schedules.json) when there is one, never "North American Tour".
  const fmt = (d: string) => formatShowDate(d, { month: 'long', day: 'numeric' });
  if (isTour && show.status !== 'closed' && tour && (tour.now || tour.next)) {
    const nowPart = tour.now ? `The ${show.title} national tour is playing ${tour.now.venue} in ${tour.now.city} through ${fmt(tour.now.end)}.` : '';
    const nextPart = tour.next ? ` ${tour.now ? 'Next it' : `The ${show.title} national tour next`} plays ${tour.next.venue} in ${tour.next.city} from ${fmt(tour.next.start)}.` : '';
    faqs.push({
      question: `Where is the ${show.title} national tour playing now?`,
      answer: `${nowPart}${nextPart}`.trim(),
    });
  }
  // Announced shows often have no theater yet: never print "at null".
  const at = show.venue ? ` at ${show.venue}` : '';
  if (!isTour) faqs.push({
    question: `Is ${show.title} still running ${marketLabel}?`,
    answer: show.status === 'open'
      ? `Yes, ${show.title} is currently playing${at} ${marketLabel}.${closingDateStr ? ` It is scheduled to close on ${closingDateStr}.` : ''}`
      : show.status === 'previews'
      ? `${show.title} is currently in previews${at}.${openingDateStr ? ` It officially opens on ${openingDateStr}.` : ''}`
      : show.status === 'upcoming'
      ? `${show.title} is upcoming${at}. Previews begin ${previewsStartStr || 'soon'}${openingDateStr ? ` and it officially opens on ${openingDateStr}.` : '.'}`
      : show.status === 'announced'
      ? `${show.title} has been announced${at}.${openingDateStr ? ` It opens on ${openingDateStr}.` : ' Dates have not been set yet.'}`
      : `No, ${show.title} has closed. It played${at}${closingDateStr ? ` and closed on ${closingDateStr}` : ''}.`,
  });

  // Q: Where is it playing?
  if (show.status !== 'closed' && !isTour && show.venue) {
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

  return faqs;
}

export function generateShowFAQSchema(show: ComputedShow, consensusText?: string | null, tour?: TourNowNext | null) {
  const faqs = getShowFAQs(show, consensusText, tour);
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
  shows: { id?: string; title: string; slug: string; venue?: string; criticScore?: { score: number; reviewCount: number; tier1Count?: number; tier2Count?: number } | null; status?: string; closingDate?: string | null; type?: string; category?: string }[],
) {
  const isLondon = shows.length > 0 && isLondonMarket(shows[0].category);
  const isOffBroadway = shows.length > 0 && shows[0].category === 'off-broadway';
  const isRegional = shows.length > 0 && shows[0].category === 'regional';
  const isTour = shows.length > 0 && shows[0].category === 'tour';
  const marketLabel = isLondon ? 'in London' : isOffBroadway ? 'Off-Broadway' : isRegional ? 'in a regional production' : isTour ? 'on tour' : 'on Broadway';
  const outletNames = isLondon
    ? 'The Guardian, Telegraph, Time Out, and WhatsOnStage'
    : isTour
    ? 'the local newspapers in each city the tour visits'
    : 'The New York Times, Vulture, and Variety';
  if (shows.length === 0) return null;

  const faqs: { question: string; answer: string }[] = [];

  // Q: What are the best shows in this category?
  // The tours page also lists tours still waiting on a score; a tour counts as
  // scored by the badge rule (extra reviews needed with no T1/T2), not the bare minimum.
  const hasScore = (s: typeof shows[number]) => !!s.criticScore?.score
    && displaysCriticScore(s)
    && (s.category !== 'tour' || isTourScored({ category: 'tour', criticScore: s.criticScore } as Parameters<typeof isTourScored>[0]));
  const topShows = shows
    .filter(hasScore)
    .slice(0, 5);

  if (topShows.length >= 2) {
    const listStr = topShows
      .map((s, i) => `${i + 1}. ${s.title} (${Math.round(s.criticScore!.score)}/100)`)
      .join(', ');
    faqs.push({
      question: isTour ? 'What are the best-reviewed national tours?' : `What are the ${pageTitle.toLowerCase()}?`,
      answer: `Based on aggregated critic reviews, the top-rated are: ${listStr}. Scores are based on reviews from major outlets including ${outletNames}.`,
    });
  }

  // Q: How many shows are in this category?
  const openShows = shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming');
  if (openShows.length > 0) {
    // The tours page lists unscored tours too ("Reviews coming in"); say how
    // many of the running ones have a score instead of calling them all scored.
    const scoredOpen = openShows.filter(hasScore).length;
    faqs.push(isTour ? {
      question: 'How many national tours are on the road now?',
      answer: `${openShows.length} national tours are on the road or announced, ${scoredOpen} of them with critic scores. The rest are waiting on enough local reviews for a score.`,
    } : {
      question: `How many ${pageTitle.toLowerCase().replace('best ', '')} are currently ${marketLabel}?`,
      answer: `There are currently ${openShows.length} ${pageTitle.toLowerCase().replace('best ', '')} playing ${marketLabel}.`,
    });
  }

  // Q: What is the highest rated?
  const topShow = topShows[0];
  if (topShow?.criticScore) {
    faqs.push({
      question: isTour ? 'What is the highest-rated national tour?' : `What is the highest-rated among the ${pageTitle.toLowerCase()}?`,
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
      `${s.title} (closes ${formatShowDate(s.closingDate, { month: 'long', day: 'numeric', year: 'numeric' })})`
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
  /** 'Broadway' | 'West End' | ... from criticMarketLabel(); defaults to Broadway. */
  marketLabel?: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: critic.name,
    url: `${BASE_URL}/critics/${critic.slug}`,
    jobTitle: 'Theater Critic',
    knowsAbout: `${critic.marketLabel ?? 'Broadway'} Theater`,
    worksFor: critic.outlets && critic.outlets.length > 1
      ? critic.outlets.map(o => ({ '@type': 'Organization' as const, name: o }))
      : { '@type': 'Organization', name: critic.primaryOutlet },
    description: `${critic.name} is a ${critic.marketLabel ?? 'Broadway'} theater critic at ${critic.primaryOutlet} with ${critic.reviewCount} reviews and an average score of ${critic.avgScore}/100.`,
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
      answer: `Broadway Scorecard aggregates critic reviews from over 400 outlets to create a single CriticScore (0-100) for every Broadway show. We currently track ${stats.totalShows.toLocaleString()} scored shows and ${stats.totalReviews.toLocaleString()} reviews across Broadway, Off-Broadway, the West End and more.`,
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

