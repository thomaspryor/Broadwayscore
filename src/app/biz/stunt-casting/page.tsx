/**
 * /biz/stunt-casting - how often new Broadway productions open with a film/TV
 * star in the lead, season by season since 2004-05, and whether it pays
 * (BRO-5848). Extends the owner's March 2026 r/Broadway analysis.
 *
 * Data: public/data/research/stunt-casting.json, built by
 * scripts/build-stunt-casting-dataset.js. Every number on the page is read
 * from that file at build time, so a rebuild updates the copy too.
 */

import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import type { Metadata } from 'next';

import { featureFlags } from '@/config/feature-flags';
import { BASE_URL, generateBreadcrumbSchema } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import BizHeader from '@/components/biz/BizHeader';

type Fame = 'screen' | 'music' | 'other' | 'stage' | 'none';
type Headliner = { name: string; fame: Fame; knownFor: string };
type Rate = { n: number; hits: number; pct: number | null };
type Split = { plays: Rate; musicals: Rate; all: Rate };
type Group = {
  n: number;
  grossN: number;
  medianGrossIndex: number | null;
  medianCapacity: number | null;
  medianAtp: number | null;
  medianWeeks: number | null;
  decidedN: number;
  recoupPct: number | null;
};
type Row = {
  id: string;
  slug: string;
  title: string;
  type: 'play' | 'musical';
  season: string;
  openingDate: string;
  isRevival: boolean;
  headliners: Headliner[];
  screenStar: boolean;
  celebrity: boolean;
};
type Dataset = {
  generated: string;
  method: Record<string, string>;
  counts: { productions: number; studyShows: number };
  eras: Array<{ label: string; screen: Split; celebrity: Split }>;
  seasons: Array<{ season: string; screen: Split; celebrity: Split }>;
  commercial: { since: string; openingWindowWeeks: number; play: { star: Group; noStar: Group }; musical: { star: Group; noStar: Group } };
  rows: Row[];
};

function loadData(): Dataset {
  const p = path.join(process.cwd(), 'public/data/research/stunt-casting.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const DATA = loadData();
const URL = `${BASE_URL}/biz/stunt-casting`;
const TITLE = 'Stunt Casting on Broadway, 2004 to Today';
const DESCRIPTION = `How often Broadway plays and musicals, new works and revivals alike, open with a film or TV star in the lead, season by season across ${DATA.counts.productions} productions, and whether star casting shows up in the grosses and recoupment.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    type: 'article',
    images: [bizOgImage('stunt-casting', TITLE)],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [bizOgImage('stunt-casting', TITLE)] },
};

/** "2024-2025" -> "2024–25" */
function shortSeason(season: string): string {
  return `${season.slice(0, 4)}–${season.slice(7)}`;
}

// Fewest shows behind a printed percentage. Below it the cell shows only the
// raw count ("2 of 4"), which cannot be mistaken for a trend.
const MIN_PCT_N = 10;
// Fewest shows with a known outcome, per group, before the page compares
// recoupment rates in words. Below 30 a 10-point gap is noise.
const MIN_RECOUP_COMPARE_N = 30;

function fmtPct(r: Rate): string {
  // From the raw counts: r.pct is already rounded to 0.1, and rounding twice can skew by a point.
  return r.n >= MIN_PCT_N ? `${Math.round((r.hits / r.n) * 100)}%` : '–';
}

function Bar({ pct, tone }: { pct: number | null; tone: 'brand' | 'muted' }) {
  return (
    <div className="h-2 rounded-full bg-white/5 min-w-[4rem]">
      <div
        className={`h-2 rounded-full ${tone === 'brand' ? 'bg-brand' : 'bg-white/30'}`}
        style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
      />
    </div>
  );
}

function SplitCell({ r, tone }: { r: Rate; tone: 'brand' | 'muted' }) {
  return (
    <td className="py-2.5 px-2 sm:px-3 align-middle">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-white tabular-nums w-9 sm:w-10 text-right">{fmtPct(r)}</span>
        <div className="flex-1 hidden sm:block"><Bar pct={r.n >= MIN_PCT_N ? r.pct : null} tone={tone} /></div>
      </div>
      <span className="block text-xs text-fg-muted whitespace-nowrap sm:ml-12">{r.hits} of {r.n}</span>
    </td>
  );
}

function fameLabel(f: Fame): string {
  return { screen: 'Film/TV', music: 'Music', other: 'Celebrity', stage: 'Stage', none: '' }[f];
}

function HeadlinerList({ headliners, onlyCelebrities }: { headliners: Headliner[]; onlyCelebrities?: boolean }) {
  const list = onlyCelebrities ? headliners.filter((h) => h.fame === 'screen' || h.fame === 'music' || h.fame === 'other') : headliners;
  if (list.length === 0) return <span className="text-fg-muted">Ensemble show, no lead</span>;
  return (
    <>
      {list.map((h, i) => (
        <span key={h.name}>
          {i > 0 && ', '}
          <span className={h.fame === 'screen' ? 'text-white' : 'text-gray-300'}>{h.name}</span>
          {h.knownFor && onlyCelebrities && <span className="text-fg-muted"> ({h.knownFor})</span>}
          {!onlyCelebrities && fameLabel(h.fame) && <span className="text-fg-muted"> · {fameLabel(h.fame)}</span>}
        </span>
      ))}
    </>
  );
}

function money(n: number | null): string {
  return n == null ? '–' : `$${Math.round(n)}`;
}
function num(n: number | null, digits = 0): string {
  return n == null ? '–' : n.toFixed(digits);
}

/**
 * One-sentence read of the star vs. no-star comparison, built from the
 * numbers so it can never contradict the table. Null when the samples are
 * too thin to say anything.
 */
function payoff(star: Group, noStar: Group, noun: string): string | null {
  if (star.grossN < MIN_PCT_N || noStar.grossN < MIN_PCT_N) return null;
  if (star.medianGrossIndex == null || !noStar.medianGrossIndex) return null;
  const lift = Math.round((star.medianGrossIndex / noStar.medianGrossIndex - 1) * 100);
  const grossPart =
    Math.abs(lift) < 5
      ? `In their opening weeks, star-led ${noun} grossed about the same as ${noun} without one`
      : `In their opening weeks, star-led ${noun} grossed about ${Math.abs(lift)}% ${lift > 0 ? 'more' : 'less'} than ${noun} without one, measured against the typical show each week`;
  const atpGap = star.medianAtp != null && noStar.medianAtp != null ? Math.round(star.medianAtp - noStar.medianAtp) : null;
  const atpPart = atpGap != null && atpGap >= 5 ? `, with tickets about $${atpGap} pricier` : '';
  if (star.recoupPct == null || noStar.recoupPct == null || Math.min(star.decidedN, noStar.decidedN) < MIN_RECOUP_COMPARE_N) {
    return `${grossPart}${atpPart}. Too few have a settled recoupment outcome (${star.decidedN} with a star, ${noStar.decidedN} without) to say whether that paid investors back.`;
  }
  const gap = Math.round(star.recoupPct - noStar.recoupPct);
  const rates = `${Math.round(star.recoupPct)}% vs. ${Math.round(noStar.recoupPct)}%`;
  const recoupPart =
    Math.abs(gap) < 5
      ? `, yet recouped at nearly the same rate (${rates}).`
      : `, and recouped at a ${gap > 0 ? 'higher' : 'lower'} rate (${rates}).`;
  return `${grossPart}${atpPart}${recoupPart}`;
}

function CommercialTable({ label, star, noStar }: { label: string; star: Group; noStar: Group }) {
  const rowsDef: Array<{ k: string; f: (g: Group) => string; hint?: string }> = [
    { k: 'Productions', f: (g) => String(g.n) },
    { k: 'Gross vs. typical show', f: (g) => (g.medianGrossIndex == null ? '–' : `${num(g.medianGrossIndex, 2)}×`), hint: 'median, opening weeks' },
    { k: 'Capacity', f: (g) => (g.medianCapacity == null ? '–' : `${num(g.medianCapacity)}%`), hint: 'median, opening weeks' },
    { k: 'Average ticket', f: (g) => money(g.medianAtp), hint: 'median, opening weeks' },
    { k: 'Weeks of grosses reported', f: (g) => num(g.medianWeeks), hint: 'median, whole run' },
    {
      k: 'Recouped',
      f: (g) => (g.decidedN >= MIN_PCT_N && g.recoupPct != null ? `${Math.round(g.recoupPct)}% of ${g.decidedN}` : '–'),
      hint: 'commercial runs with a settled outcome',
    },
  ];
  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="px-4 pt-4 text-sm font-semibold text-white">{label}</div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="text-left text-gray-400 border-b border-white/10">
            <th className="py-2 px-4 font-medium"><span className="sr-only">Measure</span></th>
            <th className="py-2 px-3 font-medium text-right">Film/TV star lead</th>
            <th className="py-2 px-4 font-medium text-right">No film/TV star</th>
          </tr>
        </thead>
        <tbody>
          {rowsDef.map((r) => (
            <tr key={r.k} className="border-b border-white/5">
              <td className="py-2.5 px-4 text-gray-300">
                {r.k}
                {r.hint && <span className="block text-xs text-fg-muted">{r.hint}</span>}
              </td>
              <td className="py-2.5 px-3 text-right font-semibold text-white tabular-nums whitespace-nowrap">{r.f(star)}</td>
              <td className="py-2.5 px-4 text-right text-gray-300 tabular-nums whitespace-nowrap">{r.f(noStar)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StuntCastingPage() {

  const { eras, seasons, commercial, rows } = DATA;
  const ordered = [...seasons].sort((a, b) => b.season.localeCompare(a.season));
  const latest = ordered[0];
  // The latest season is in progress until July 1 after it starts plus a year.
  const today = new Date().toISOString().slice(0, 10);
  const latestInProgress = !!latest && today < `${latest.season.slice(5)}-07-01`;
  const lastFull = latestInProgress ? ordered[1] : latest;

  const peakPlays = [...seasons]
    .filter((s) => s.screen.plays.n >= 10)
    .sort((a, b) => (b.screen.plays.pct ?? 0) - (a.screen.plays.pct ?? 0) || b.season.localeCompare(a.season))[0];
  const firstEra = eras[0];
  const lastEra = eras[eras.length - 1];

  const bySeason = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySeason.get(r.season) ?? [];
    list.push(r);
    bySeason.set(r.season, list);
  }
  for (const list of bySeason.values()) list.sort((a, b) => a.openingDate.localeCompare(b.openingDate));
  const recentStarShows = [latest, ordered[1]]
    .filter(Boolean)
    .flatMap((s) => (bySeason.get(s.season) ?? []).filter((r) => r.celebrity));

  // The page is public (owner, 2026-10-21) while /biz itself is still held,
  // so the way back is the public Season Report until /biz launches.
  const parent = featureFlags.commercial
    ? { name: 'Profitability Scorecard', href: '/biz' }
    : { name: 'Season Report', href: '/season-report' };

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: parent.name, url: `${BASE_URL}${parent.href}` },
    { name: 'Stunt Casting', url: URL },
  ]);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <div className="min-h-screen bg-surface">
        <div className="max-w-4xl mx-auto px-4 py-6 sm:py-8">
          <Link href={parent.href} className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {parent.name}
          </Link>

          <BizHeader title={TITLE} tagline={DESCRIPTION} sharePath="/biz/stunt-casting">
            <p className="text-xs text-fg-muted mt-5">Research · Updated {DATA.generated}</p>
          </BizHeader>

          {lastFull && (
            <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10" aria-label="Key numbers">
              <div className="card rounded-xl p-4">
                <div className="text-2xl sm:text-3xl font-bold text-brand tabular-nums">{fmtPct(lastFull.screen.plays)}</div>
                <div className="text-xs text-gray-400 mt-1">
                  of plays opening in {shortSeason(lastFull.season)} had a film/TV star lead ({lastFull.screen.plays.hits} of {lastFull.screen.plays.n})
                </div>
              </div>
              <div className="card rounded-xl p-4">
                <div className="text-2xl sm:text-3xl font-bold text-white tabular-nums">{fmtPct(lastFull.screen.musicals)}</div>
                <div className="text-xs text-gray-400 mt-1">
                  of musicals opening in {shortSeason(lastFull.season)} ({lastFull.screen.musicals.hits} of {lastFull.screen.musicals.n})
                </div>
              </div>
              {firstEra && (
                <div className="card rounded-xl p-4">
                  <div className="text-2xl sm:text-3xl font-bold text-white tabular-nums">{fmtPct(firstEra.screen.plays)}</div>
                  <div className="text-xs text-gray-400 mt-1">of plays in {firstEra.label}, for comparison</div>
                </div>
              )}
              <div className="card rounded-xl p-4">
                <div className="text-2xl sm:text-3xl font-bold text-white tabular-nums">{DATA.counts.productions}</div>
                <div className="text-xs text-gray-400 mt-1">productions classified since 2004–05</div>
              </div>
            </section>
          )}

          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-2">The long view</h2>
            <p className="text-sm text-gray-400 mb-3">
              Share of productions (new works and revivals) with a film or TV star among their headliners, in five-season eras.
              {firstEra && lastEra && firstEra !== lastEra && (
                <>
                  {' '}Plays went from {fmtPct(firstEra.screen.plays)} in {firstEra.label} to {fmtPct(lastEra.screen.plays)} in {lastEra.label};
                  musicals from {fmtPct(firstEra.screen.musicals)} to {fmtPct(lastEra.screen.musicals)}.
                </>
              )}
            </p>
            <div className="card rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-white/10">
                    <th className="py-2 px-4 font-medium">Seasons</th>
                    <th className="py-2 px-3 font-medium">Plays</th>
                    <th className="py-2 px-3 font-medium">Musicals</th>
                  </tr>
                </thead>
                <tbody>
                  {eras.map((e) => (
                    <tr key={e.label} className="border-b border-white/5">
                      <td className="py-2.5 px-4 text-gray-300 whitespace-nowrap">
                        {e.label}
                        {latestInProgress && latest && e === lastEra && (
                          <span className="block text-xs text-fg-muted">{shortSeason(latest.season)} so far</span>
                        )}
                      </td>
                      <SplitCell r={e.screen.plays} tone="brand" />
                      <SplitCell r={e.screen.musicals} tone="muted" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {peakPlays && (
              <p className="text-sm text-gray-400 mt-3">
                The single most star-heavy season for plays was {shortSeason(peakPlays.season)}, at {fmtPct(peakPlays.screen.plays)} ({peakPlays.screen.plays.hits} of {peakPlays.screen.plays.n}).
              </p>
            )}
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-2">Season by season</h2>
            <p className="text-sm text-gray-400 mb-3">
              Film/TV star leads by season. The last column widens the count to any non-theater celebrity (pop stars, comedians, athletes).
              {latestInProgress && latest && ` ${shortSeason(latest.season)} is still in progress and counts only shows that have opened.`}
            </p>
            <div className="card rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-white/10">
                    <th className="py-2 pl-3 pr-2 sm:px-4 font-medium">Season</th>
                    <th className="py-2 px-3 font-medium">Plays</th>
                    <th className="py-2 px-3 font-medium">Musicals</th>
                    <th className="py-2 px-2 sm:px-3 font-medium">Any celebrity</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((s) => (
                    <tr key={s.season} className="border-b border-white/5">
                      <td className="py-2.5 pl-3 pr-2 sm:px-4 text-gray-300 whitespace-nowrap">
                        {shortSeason(s.season)}
                        {latestInProgress && s === latest && <span className="block text-xs text-fg-muted">so far</span>}
                      </td>
                      <SplitCell r={s.screen.plays} tone="brand" />
                      <SplitCell r={s.screen.musicals} tone="muted" />
                      <td className="py-2.5 px-2 sm:px-3 text-gray-300 tabular-nums whitespace-nowrap">{fmtPct(s.celebrity.all)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-2">Does it pay?</h2>
            <p className="text-sm text-gray-400 mb-3">
              Productions that opened from {shortSeason(commercial.since)} on, with and without a film/TV star lead. Box office covers
              each show&apos;s first {commercial.openingWindowWeeks} reported weeks, when the opening cast is usually still in place, and compares its
              weekly gross with the median Broadway show that same week, so a 2015 run and a 2025 run sit on the same scale. Nonprofit-theater productions are left out: they have no investors to pay back. This shows
              association, not cause: star vehicles also tend to be short, limited runs.
            </p>
            {payoff(commercial.play.star, commercial.play.noStar, 'plays') && (
              <p className="text-gray-200 leading-relaxed mb-4">{payoff(commercial.play.star, commercial.play.noStar, 'plays')}</p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <CommercialTable label="Plays" star={commercial.play.star} noStar={commercial.play.noStar} />
              <CommercialTable label="Musicals" star={commercial.musical.star} noStar={commercial.musical.noStar} />
            </div>
          </section>

          {recentStarShows.length > 0 && (
            <section className="mb-10">
              <h2 className="text-xl font-bold text-white mb-2">Recent celebrity headliners</h2>
              <p className="text-sm text-gray-400 mb-3">
                Every production in {[latest, ordered[1]].filter(Boolean).map((s) => shortSeason(s.season)).join(' and ')} with a non-theater celebrity among its headliners.
              </p>
              <ul className="card rounded-xl divide-y divide-white/5">
                {recentStarShows.map((r) => (
                  <ShowLinkListItem key={r.id} href={`/show/${r.slug}`} className="px-4 py-3 text-sm">
                    <Link href={`/show/${r.slug}`} className="font-semibold text-white hover:text-brand"><RowLinkArrow label={r.title} /></Link>
                    <span className="text-xs text-fg-muted"> · {r.type === 'play' ? 'Play' : 'Musical'} · {shortSeason(r.season)}</span>
                    <div className="text-gray-400 mt-0.5"><HeadlinerList headliners={r.headliners} onlyCelebrities /></div>
                  </ShowLinkListItem>
                ))}
              </ul>
            </section>
          )}

          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-2">Every production, every headliner</h2>
            <p className="text-sm text-gray-400 mb-3">Open a season to check how each show was classified.</p>
            <div className="space-y-2">
              {ordered.map((s) => (
                <details key={s.season} className="card rounded-xl">
                  <summary className="px-4 py-3 cursor-pointer text-sm text-white flex justify-between gap-3">
                    <span>{shortSeason(s.season)}</span>
                    <span className="text-fg-muted">{s.screen.all.hits} of {s.screen.all.n} with a film/TV star</span>
                  </summary>
                  <ul className="divide-y divide-white/5 border-t border-white/5">
                    {(bySeason.get(s.season) ?? []).map((r) => (
                      <ShowLinkListItem key={r.id} href={`/show/${r.slug}`} className="px-4 py-2.5 text-sm">
                        <Link href={`/show/${r.slug}`} className={r.screenStar ? 'text-brand hover:text-brand-hover' : 'text-gray-200 hover:text-white'}>
                          <RowLinkArrow label={r.title} />
                        </Link>
                        <span className="text-xs text-fg-muted"> · {r.type === 'play' ? 'Play' : 'Musical'}</span>
                        <div className="text-xs text-gray-400 mt-0.5"><HeadlinerList headliners={r.headliners} /></div>
                      </ShowLinkListItem>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </section>

          <section className="mb-6 text-sm text-gray-400 space-y-2">
            <h2 className="text-base font-semibold text-white">How this was measured</h2>
            <p>{DATA.method.scope}</p>
            <p>{DATA.method.classification}</p>
            {DATA.method.classifierReview && <p>{DATA.method.classifierReview}</p>}
            <p>{DATA.method.grossIndex}</p>
            <p>{DATA.method.recoupment}</p>
          </section>
        </div>
      </div>
    </>
  );
}
