/**
 * /path-to-broadway - how new Broadway productions got to Broadway (straight
 * in, Off-Broadway, a US regional theater or tryout, London, another
 * country), what they were based on, and which kinds recouped (BRO-5842).
 * Aggregates only, like the Season Report: no budgets, and only shows that
 * recouped are named in the recoupment section. Route and source labels come
 * from data/show-origins.json (scripts/classify-show-origins.js), each with a
 * source link. Held (featureFlags.pathToBroadway) until the owner's go.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { featureFlags } from '@/config/feature-flags';
import { getOriginFindings } from '@/lib/data-commercial';
import { getMarketDate } from '@/lib/date-utils';
import { formatDataDate } from '@/lib/biz-format';
import { BASE_URL, SITE_OG_IMAGE, generateBreadcrumbSchema } from '@/lib/seo';
import {
  ERAS,
  ROUTE_BUCKETS,
  SOURCE_BUCKETS,
  sourceBucket,
  type OriginFindings,
  type OriginListShow,
} from '@/lib/show-origins';

import OriginMixTable from '@/components/biz/OriginMixTable';
import OriginRecoupTable, { SOLID_SAMPLE } from '@/components/biz/OriginRecoupTable';

export const metadata: Metadata = {
  title: 'Path to Broadway: Where New Broadway Shows Come From',
  description:
    'How every new Broadway production since 2000-01 got to Broadway (Off-Broadway, regional theaters, London, straight in) and what it was based on, plus recoupment rates for recent seasons.',
  alternates: { canonical: `${BASE_URL}/path-to-broadway` },
  openGraph: {
    images: [SITE_OG_IMAGE],
    title: 'Path to Broadway',
    description: 'Where new Broadway shows come from, what they are based on, and which kinds recoup.',
    url: `${BASE_URL}/path-to-broadway`,
  },
};

function shortSeason(season: string): string {
  return `${season.slice(0, 4)}-${season.slice(7)}`;
}

/** Screen-reader name for each section a finding links to. */
const SECTION_NAME: Record<string, string> = {
  '#routes': 'routes to Broadway',
  '#sources': 'source material',
};

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

const ROUTE_LABEL = new Map<string, string>(ROUTE_BUCKETS.map((b) => [b.id, b.label]));
const SOURCE_LABEL = new Map<string, string>(SOURCE_BUCKETS.map((b) => [b.id, b.label]));

interface FindingItem {
  text: string;
  href: string;
}

function Finding({ item }: { item: FindingItem }) {
  return (
    <>
      {item.text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i} className="font-semibold text-white">{part}</strong> : part))}{' '}
      <a href={item.href} className="text-brand hover:text-brand-hover whitespace-nowrap">See the data<span className="sr-only"> on {SECTION_NAME[item.href] ?? 'this'}</span></a>
    </>
  );
}

/** Plain-English headline findings, each computed from the tables below (never hand-written figures). */
function keyFindings(f: OriginFindings): FindingItem[] {
  const out: FindingItem[] = [];
  const first = 0;
  const lastEra = ERAS.length - 1;

  const direct = f.routeMix.find((r) => r.id === 'direct');
  if (direct && f.eraTotals[first] && f.eraTotals[lastEra]) {
    const now = pct(direct.counts[lastEra], f.eraTotals[lastEra]);
    const then = pct(direct.counts[first], f.eraTotals[first]);
    out.push({
      text: `**${now}** of new Broadway productions since 2020-21 came straight to Broadway with no earlier staging. In the 2000s it was ${now === then ? 'the same' : `**${then}**`}.`,
      href: '#routes',
    });
  }

  const screen = f.musicalSourceMix.find((r) => r.id === 'screen');
  if (screen && f.musicalEraTotals[first] && f.musicalEraTotals[lastEra]) {
    out.push({
      text: `**${pct(screen.counts[lastEra], f.musicalEraTotals[lastEra])}** of new musicals since 2020-21 were adapted from a movie or TV show (${screen.counts[lastEra]} of ${f.musicalEraTotals[lastEra]}). In the 2000s: **${pct(screen.counts[first], f.musicalEraTotals[first])}**.`,
      href: '#sources',
    });
  }

  const rl = f.revivalsFromLondon;
  if (rl.totals[first] && rl.totals[lastEra]) {
    out.push({
      text: `Revivals that came from London: **${pct(rl.counts[lastEra], rl.totals[lastEra])}** of Broadway revivals since 2020-21, against **${pct(rl.counts[first], rl.totals[first])}** in the 2000s.`,
      href: '#routes',
    });
  }
  return out;
}

function ShowLine({ show }: { show: OriginListShow }) {
  const src = SOURCE_LABEL.get(sourceBucket(show.source, show.originalKind)) ?? show.source;
  return (
    <li className="py-1.5 border-b border-white/5 last:border-b-0 min-w-0 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <Link href={`/show/${show.slug}`} className="text-gray-200 hover:text-white underline decoration-white/25 underline-offset-2 hover:decoration-white">{show.title}</Link>
        <span className="text-xs text-fg-muted whitespace-nowrap">{show.openingDate.slice(0, 4)} · {show.type === 'musical' ? 'Musical' : 'Play'}</span>
      </div>
      <p className="text-xs text-fg-muted mt-0.5">
        {show.pathNote ? `${show.pathNote}. ` : ''}
        {show.sourceTitle ? `Based on ${show.sourceTitle} (${src.toLowerCase()}).` : `${src}.`}
        {show.evidence && (
          <>
            {' '}
            <a href={show.evidence} className="text-brand hover:text-brand-hover" rel="nofollow noopener" target="_blank">Source</a>
          </>
        )}
      </p>
    </li>
  );
}

export default function PathToBroadwayPage() {
  if (!featureFlags.pathToBroadway) notFound();
  const today = getMarketDate('broadway');
  const f = getOriginFindings(today);
  const findings = keyFindings(f);
  const cur = f.currentSeason && f.currentTotal > 0 ? { label: shortSeason(f.currentSeason), total: f.currentTotal } : null;
  const musicalCur = f.currentSeason && f.musicalCurrentTotal > 0 ? { label: shortSeason(f.currentSeason), total: f.musicalCurrentTotal } : null;
  const byRoute = ROUTE_BUCKETS.map((b) => ({ ...b, shows: f.showList.filter((s) => s.route === b.id) })).filter((g) => g.shows.length > 0);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Path to Broadway', url: `${BASE_URL}/path-to-broadway` },
  ]);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <div className="min-h-screen bg-surface">
        <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
          <header className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-white leading-tight sm:leading-tight pb-0.5">Path to Broadway</h1>
            <p className="text-gray-400 mt-2">
              Where {f.newProductions} new Broadway productions since the 2000-01 season came from ({f.musicals} musicals
              and {f.plays} plays), what they were based on, and, for recent seasons, which kinds earned their money back.
            </p>
            <p className="text-xs text-fg-muted mt-1" data-testid="path-asof">
              As of {formatDataDate(today) ?? today}. Eras count shows that have opened. New productions only: revivals and
              return engagements are counted separately. The 2020s column runs from 2020-21 to now, including the
              pandemic shutdown; the far-right column is the current season alone, including new productions announced or in previews that have not opened yet.
            </p>
          </header>

          {findings.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-3">Highlights</h2>
              <ul className="card rounded-xl p-4 space-y-2 text-gray-300 list-disc list-inside" data-testid="path-findings">
                {findings.map((item) => <li key={item.text}><Finding item={item} /></li>)}
              </ul>
            </section>
          )}

          <section id="routes" className="mb-8 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-1">How Shows Got Here</h2>
            <p className="text-sm text-gray-400 mb-3">
              Each new production by its earlier staged runs. &quot;Two or more stops&quot; covers shows like Hadestown
              (Off-Broadway, then Canada, then London). Readings, workshops and concerts don&apos;t count.
            </p>
            <OriginMixTable rows={f.routeMix} totals={f.eraTotals} current={cur} testId="route-mix" />
            <div className="card rounded-xl p-4 mt-3 text-sm text-gray-300" data-testid="ever-played">
              <p className="text-white font-semibold mb-2">Played there at some point before Broadway</p>
              <ul className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {f.everPlayed.map((e) => (
                  <li key={e.stage}>
                    <span className="block text-2xl font-bold text-white">{f.newProductions ? pct(e.count, f.newProductions) : '–'}</span>
                    <span className="block text-xs text-gray-400">{e.label} ({e.count})</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-fg-muted mt-3">
                Revivals that came from London:{' '}
                {ERAS.map((e, i) => `${e.id} ${f.revivalsFromLondon.totals[i] ? pct(f.revivalsFromLondon.counts[i], f.revivalsFromLondon.totals[i]) : '–'} (${f.revivalsFromLondon.counts[i]} of ${f.revivalsFromLondon.totals[i]})`).join(', ')}.
              </p>
            </div>
          </section>

          <section id="sources" className="mb-8 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-1">What They&apos;re Based On</h2>
            <p className="text-sm text-gray-400 mb-3">
              Every new production by its source. Musicals built on an existing song catalog count as jukebox unless
              they adapt a movie or book. Original works are split by story: a true story is about real people or
              events (Come From Away, Oslo) without adapting a specific book or film; an invented story is made up
              (Dear Evan Hansen, Stereophonic).
            </p>
            <OriginMixTable rows={f.sourceMix} totals={f.eraTotals} current={cur} testId="source-mix" />
            <h3 className="text-lg font-semibold text-white mt-5 mb-2">Musicals only</h3>
            <OriginMixTable rows={f.musicalSourceMix} totals={f.musicalEraTotals} current={musicalCur} testId="musical-source-mix" />
          </section>

          {f.recoupRange && (
            <section id="who-recoups" className="mb-8 scroll-mt-20">
              <h2 className="text-xl font-bold text-white mb-1">Who Recoups</h2>
              <p className="text-sm text-gray-400 mb-3">
                Commercial new productions that opened from {shortSeason(f.recoupRange[0])} to {shortSeason(f.recoupRange[1])},
                the seasons our recoupment records cover well. Groups are small, so one show can move a rate by several
                points. Rates on fewer than {SOLID_SAMPLE} shows are dimmed; groups under 3 shows show a dash.
              </p>
              <h3 className="text-lg font-semibold text-white mb-2">By route</h3>
              <OriginRecoupTable rows={f.routeRecoup} testId="route-recoup" noun="route" />
              <h3 className="text-lg font-semibold text-white mt-5 mb-2">By source</h3>
              <OriginRecoupTable rows={f.sourceRecoup} testId="source-recoup" noun="source" />
              <p className="mt-3 text-xs text-fg-muted">
                Leaves out nonprofit-only runs and tour stops, which have no investors to repay, and the 2019-20 and
                2020-21 seasons. Shows still running count as not recouped yet, so rates can only go up. Recoupment
                comes from producer announcements and trade press. These are counts, not causes: shows that try out
                first are often the ones producers already believed in.
              </p>
            </section>
          )}

          <section id="every-show" className="mb-8 scroll-mt-20" data-testid="path-show-list">
            <h2 className="text-xl font-bold text-white mb-1">Every Show</h2>
            <p className="text-sm text-gray-400 mb-3">
              Each label links to the page it came from. Spot a mistake?{' '}
              <Link href="/feedback" className="text-brand hover:text-brand-hover">Tell us</Link>.
            </p>
            <div className="space-y-2">
              {byRoute.map((g) => (
                <details key={g.id} className="card rounded-xl px-4 py-3">
                  <summary className="cursor-pointer text-white font-semibold">
                    {ROUTE_LABEL.get(g.id)} <span className="text-fg-muted font-normal">({g.shows.length})</span>
                  </summary>
                  <ul className="mt-2 text-sm">
                    {g.shows.map((s) => <ShowLine key={s.slug} show={s} />)}
                  </ul>
                </details>
              ))}
            </div>
          </section>

          <section className="mb-8 text-xs text-fg-muted space-y-1">
            <p>
              How we label shows: for each production we searched IBDB, Playbill, Wikipedia and trade press for its
              earlier staged runs and its source material, and kept only labels backed by a page we could link.
              Out-of-town tryouts in US cities count as regional. London covers the West End and other UK theaters.
            </p>
            <p>
              See also the <Link href="/season-report" className="text-brand hover:text-brand-hover">Broadway Season Report</Link>.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
