import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { isCategoryEnabled } from '@/lib/markets';
import { getTourCities, getTourCity, type TourCity } from '@/lib/data-tour-cities';
import { getTourStopTickets } from '@/lib/data-tour-schedule';
import { seasonLabel } from '@/lib/tour-cities';
import { shortCity, stopKey } from '@/lib/tour-schedule';
import { isTourListed } from '@/lib/data-core';
import { serializeShowForClient } from '@/lib/serialize-show';
import { formatShowDate } from '@/lib/date-utils';
import { BASE_URL, generateBreadcrumbSchema, tourSubEvents } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';
import HowThisWorks from '@/components/HowThisWorks';
import TicketLink from '@/components/TicketLink';
import { ShowListCard } from '@/components/show-cards';

// National-tour city pages (BRO-4601 phase 5). One page per city with enough
// listed tours (src/lib/data-tour-cities.ts); the cards are the browse list's
// ShowListCard with this city's stop as the tour line and ticket link.

export const revalidate = 86400;
export const dynamicParams = false;

const TOURS_HUB = '/browse/broadway-national-tours';

export function generateStaticParams() {
  if (!isCategoryEnabled('tour')) return [];
  return Array.from(getTourCities().keys()).map(city => ({ city }));
}

type Stop = TourCity['stops'][number];

function split(c: TourCity, today: string) {
  const now = c.stops.filter(s => s.start <= today && today <= s.end);
  const ahead = c.stops.filter(s => s.start > today);
  const past = c.stops.filter(s => s.end < today).reverse();
  return { now, ahead, past };
}

/** "Oct 13–Nov 1", "Nov 13–15", "Dec 29, 2026–Jan 3, 2027". */
function stopRange(s: Stop): string {
  const md = { month: 'short', day: 'numeric' } as const;
  if (s.start === s.end) return formatShowDate(s.start, md);
  if (s.start.slice(0, 4) !== s.end.slice(0, 4)) {
    return `${formatShowDate(s.start, { ...md, year: 'numeric' })}–${formatShowDate(s.end, { ...md, year: 'numeric' })}`;
  }
  const end = s.start.slice(0, 7) === s.end.slice(0, 7) ? String(Number(s.end.slice(8, 10))) : formatShowDate(s.end, md);
  return `${formatShowDate(s.start, md)}–${end}`;
}

const scoreOf = (s: Stop) => (isTourListed(s.show) ? s.show.criticScore?.score ?? null : null);

/** Listed tours still to come in the city, best score first, one per tour. */
function bestAhead(c: TourCity, today: string): Stop[] {
  const seen = new Set<string>();
  return c.stops
    .filter(s => s.end >= today && scoreOf(s) != null)
    .sort((a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0))
    .filter(s => (seen.has(s.showId) ? false : (seen.add(s.showId), true)));
}

function intro(c: TourCity, today: string): string {
  const place = shortCity(c.city);
  const ahead = c.stops.filter(s => s.end >= today);
  const tours = new Set(ahead.map(s => s.showId)).size;
  const best = bestAhead(c, today).slice(0, 2);
  const venues = Array.from(new Set(ahead.map(s => s.venue))).slice(0, 3);
  if (!tours) return `No Broadway tours are booked into ${place} right now. Here are the tours that played ${place} in the past year, with their critic scores.`;
  const last = ahead.reduce((m, s) => (s.end > m ? s.end : m), ahead[0].end);
  const parts = [`${tours} Broadway ${tours === 1 ? 'tour plays' : 'tours play'} ${place} through ${formatShowDate(last, { month: 'long', year: 'numeric' })}`];
  if (venues.length) parts[0] += `, at ${venues.length > 1 ? `${venues.slice(0, -1).join(', ')} and ${venues[venues.length - 1]}` : venues[0]}`;
  if (best.length) parts.push(`Best reviewed: ${best.map(s => `${s.show.title} (${Math.round(scoreOf(s)!)})`).join(', ')}`);
  return `${parts.join('. ')}.`;
}

export function generateMetadata({ params }: { params: { city: string } }): Metadata {
  const c = isCategoryEnabled('tour') ? getTourCity(params.city) : undefined;
  if (!c) return { title: 'Page Not Found' };
  const today = new Date().toISOString().slice(0, 10);
  const season = seasonLabel(c.stops.filter(s => s.end >= today));
  const title = `Broadway Shows in ${c.city}${season ? ` ${season}` : ''}: Tour Dates & Critic Scores`;
  const description = intro(c, today);
  const url = `${BASE_URL}/tours/${c.slug}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    ...(!c.indexed && { robots: { index: false, follow: true } }),
    openGraph: { title, description, url, type: 'website', images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: title }] },
  };
}

export default function TourCityPage({ params }: { params: { city: string } }) {
  if (!isCategoryEnabled('tour')) notFound();
  const c = getTourCity(params.city);
  if (!c) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const place = shortCity(c.city);
  const { now, ahead, past } = split(c, today);
  const season = seasonLabel([...now, ...ahead]);

  const card = (s: Stop, i: number, when: 'now' | 'ahead' | 'past') => {
    const ticket = when === 'past' ? undefined : getTourStopTickets(s.show)[stopKey(s)];
    const show = {
      ...serializeShowForClient(s.show),
      // The line above the card gives this city's dates; the card's own
      // "Now in / Next" line would name wherever the tour is elsewhere.
      tourNowNext: null,
      ticketLinks: [],
    };
    const range = stopRange(s);
    return (
      <li key={`${stopKey(s)}|${s.showId}|${i}`}>
        <p className="text-xs text-gray-500 mb-1.5 tabular-nums">
          {when === 'past' ? 'Played ' : ''}{range}{when === 'past' && s.start.slice(0, 4) === s.end.slice(0, 4) && s.start.slice(0, 4) !== today.slice(0, 4) ? `, ${s.start.slice(0, 4)}` : ''} · {s.venue}
          {/* Here, not the card's CTA: that one is hidden below sm. */}
          {ticket && (
            <>
              {' · '}
              <TicketLink
                showName={s.show.title} showId={s.show.id} showSlug={s.show.slug} showStatus={s.show.status} showCategory="tour"
                platform="TodayTix" url={ticket} pageType="browse"
                className="font-medium text-amber-400/80 hover:text-amber-300"
              >
                Tickets ↗
              </TicketLink>
            </>
          )}
        </p>
        <ShowListCard show={show} index={i} scoreMode="critics" variant="compact" showReviewCount />
      </li>
    );
  };

  const section = (title: string, stops: Stop[], when: 'now' | 'ahead' | 'past') => stops.length > 0 && (
    <section className="mb-10" aria-labelledby={`tc-${when}`}>
      <h2 id={`tc-${when}`} className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 mb-3">{title}</h2>
      <ul className="space-y-4">{stops.map((s, i) => card(s, i, when))}</ul>
    </section>
  );

  const events = [...now, ...ahead].flatMap(s => tourSubEvents(s.show, [s], today, getTourStopTickets(s.show)));
  const schemas = [
    generateBreadcrumbSchema([
      { name: 'Home', url: BASE_URL },
      { name: 'National Tours', url: `${BASE_URL}${TOURS_HUB}` },
      { name: place, url: `${BASE_URL}/tours/${c.slug}` },
    ]),
    ...(events.length ? [{
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `Broadway tours in ${place}`,
      itemListElement: events.map((e, i) => ({ '@type': 'ListItem', position: i + 1, item: e })),
    }] : []),
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }} />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: 'National Tours', href: TOURS_HUB },
          { label: place },
        ]} />
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-1">Broadway Shows Coming to {place}</h1>
          <p className="text-sm text-gray-500 mb-3">{c.city}{season ? ` · ${season} touring season` : ''}</p>
          <p className="text-gray-300 leading-relaxed">{intro(c, today)}</p>
        </div>
        {section('Now playing', now, 'now')}
        {section('Coming up', ahead, 'ahead')}
        {section('Played in the past year', past, 'past')}
        <p className="text-sm text-gray-400">
          <Link href={TOURS_HUB} className="text-brand hover:text-brand-hover font-medium">All national tours →</Link>
        </p>
        <HowThisWorks className="mt-8">
          <p>Dates come from each tour&apos;s published schedule. Scores are CriticScore, a weighted average of reviews of the touring production, including local critics in the cities it plays. A tour shows a score once enough critics have reviewed it.</p>
        </HowThisWorks>
      </div>
    </>
  );
}
