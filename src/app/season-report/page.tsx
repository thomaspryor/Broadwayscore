/**
 * /season-report - public Broadway Season Report (BRO-5777): this season's
 * pace and mix against last season and the prior 10, the season-by-season
 * history, and who recoups. Aggregates only: no budgets, running costs or
 * named money-losers. Held (featureFlags.seasonReport) until the owner's go.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { featureFlags } from '@/config/feature-flags';
import { getAllShows } from '@/lib/data-core';
import { getSeason, getSeasonComparison, getSeasonProfiles, getSeasonShowList, getRecoupFindings, type SeasonListShow } from '@/lib/data-commercial';
import { getMarketDate } from '@/lib/date-utils';
import { formatDataDate } from '@/lib/biz-format';
import { BASE_URL, SITE_OG_IMAGE, generateBreadcrumbSchema } from '@/lib/seo';
import { MIX_ROW_LABELS, MIX_ROW_LABELS_HIDDEN, SHOW_GROUPS, mix, seasonBaseline, selectSeasonAverageBase, selectSeasonHistory, showGroup, type RecoupFindings, type SeasonComparison, type SeasonProfile } from '@/lib/season-profile';

import SeasonComparisonTable from '@/components/biz/SeasonComparisonTable';
import SeasonHistoryTable from '@/components/biz/SeasonHistoryTable';
import WhoRecoupsCard from '@/components/biz/WhoRecoupsCard';
import MixCard, { type MixColumn } from '@/components/biz/MixCard';

export const metadata: Metadata = {
  title: 'Broadway Season Report: Openings, Revivals and Who Recoups',
  description:
    'This Broadway season against last season and the 10 before it: shows opened, plays vs musicals, revivals, and which kinds of shows recoup. Every show listed.',
  alternates: { canonical: `${BASE_URL}/season-report` },
  openGraph: {
    images: [SITE_OG_IMAGE],
    title: 'Broadway Season Report',
    description: 'This Broadway season against last season and the prior 10: openings, revivals and who recoups.',
    url: `${BASE_URL}/season-report`,
  },
};

function shortSeason(season: string): string {
  return `${season.slice(0, 4)}-${season.slice(7)}`;
}

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

const HIDDEN_ROW_LABELS = new Set<string>(MIX_ROW_LABELS_HIDDEN);

/** A finding with **figures** in bold, and a trailing link to the section it comes from. */
interface FindingItem {
  text: string;
  href: string;
}

function Finding({ item }: { item: FindingItem }) {
  return (
    <>
      {item.text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i} className="font-semibold text-white">{part}</strong> : part))}{' '}
      <a href={item.href} className="text-brand hover:text-brand-hover whitespace-nowrap">See the data</a>
    </>
  );
}

/** One line of the show list: linked title and its opening date (or "no date yet"). */
function ShowLine({ show, today, note }: { show: SeasonListShow; today: string; note?: string }) {
  const date = show.openingDate ? formatDataDate(show.openingDate) : null;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 border-b border-white/5 last:border-b-0">
      <Link href={`/show/${show.slug}`} className="text-gray-200 hover:text-white underline decoration-white/25 underline-offset-2 hover:decoration-white">{show.title}</Link>
      <span className="text-xs text-fg-muted whitespace-nowrap">
        {note ?? (date && show.openingDate ? `${show.openingDate <= today ? 'Opened' : 'Opens'} ${date}` : 'No date yet')}
      </span>
    </li>
  );
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** Plain-English headline findings, each computed from the tables below (never hand-written figures). */
function keyFindings(
  comparison: SeasonComparison | null,
  profiles: SeasonProfile[],
  recoup: RecoupFindings,
  currentSeason: string | null,
  compare: (season: string) => SeasonComparison | null,
  cur: SeasonProfile | null,
): FindingItem[] {
  const out: FindingItem[] = [];
  const opened = comparison?.rows.find((r) => r.label === 'Opened so far');
  if (comparison?.inProgress && opened?.current != null && opened.last != null && comparison.lastSeason) {
    const avg = opened.avg != null ? ` The ${opened.avgSeasons}-season average for this date is ${opened.avg.toFixed(1)}.` : '';
    out.push({
      text: `**${opened.current}** new Broadway ${opened.current === 1 ? 'production has' : 'productions have'} opened this season. By this date in ${shortSeason(comparison.lastSeason)}, **${opened.last}** had.${avg}`,
      href: '#this-season',
    });
  }
  if (cur && cur.playRevivalKnown > 0) {
    const prev = comparison?.lastSeason ? profiles.find((p) => p.season === comparison.lastSeason) : null;
    const was = prev && prev.playRevivalKnown > 0 ? ` In ${shortSeason(prev.season)} it was ${prev.playRevivals} of ${prev.playRevivalKnown} (${pct(prev.playRevivals, prev.playRevivalKnown)}).` : '';
    out.push({
      text: `Play revivals make up **${cur.playRevivals} of ${cur.playRevivalKnown}** plays opened or announced for ${shortSeason(cur.season)} (${pct(cur.playRevivals, cur.playRevivalKnown)}), and ${cur.playRevivals} of all ${cur.productions} productions (${pct(cur.playRevivals, cur.productions)}).${was}`,
      href: cur.playRevivals > 0 ? '#play-revivals' : '#every-show',
    });
  }

  // Last finished season's revival share, ranked among every season we track with 10+ openings.
  const ranked = profiles.filter((p) => p.productions >= 10 && p.revivalKnown > 0 && p.season !== currentSeason);
  const last = ranked.find((p) => !currentSeason || p.season < currentSeason);
  if (last) {
    const share = last.revivals / last.revivalKnown;
    const shareOf = (p: SeasonProfile) => p.revivals / p.revivalKnown;
    const rank = ranked.filter((p) => shareOf(p) > share).length + 1;
    const tied = ranked.some((p) => p !== last && shareOf(p) === share);
    const oldest = ranked[ranked.length - 1].season;
    const runnerUp = ranked.filter((p) => p !== last).sort((x, y) => shareOf(y) - shareOf(x))[0];
    const avg = compare(last.season)?.rows.find((r) => r.label === 'Revivals (all)');
    const vs = avg?.avg != null ? ` The ${avg.avgSeasons} seasons before it averaged ${Math.round(avg.avg * 100)}%.` : '';
    const rankText = rank === 1 && !tied
      ? `the highest share in our records, which go back to ${shortSeason(oldest)}${runnerUp ? `. Next highest: ${pct(runnerUp.revivals, runnerUp.revivalKnown)} in ${shortSeason(runnerUp.season)}` : ''}`
      : `${tied ? 'tied for ' : ''}the ${rank === 1 ? '' : `${ordinal(rank)} `}highest of the ${ranked.length} seasons in our records, back to ${shortSeason(oldest)}`;
    out.push({
      text: `Revivals were **${pct(last.revivals, last.revivalKnown)}** of ${shortSeason(last.season)}'s new productions, ${rankText}.${vs}`,
      href: '#season-by-season',
    });
  }

  const by = Object.fromEntries(recoup.buckets.map((b) => [b.label, b]));
  const pr = by['Play revivals'];
  const om = by['Original musicals'];
  if (pr && om && pr.total >= 10 && om.total >= 10 && om.recouped > 0 && recoup.range) {
    // State the two rates with their counts: a single "N times" multiple rests on a handful of
    // recoupments and overstates its precision (review, BRO-5777).
    if (pr.recouped / pr.total > (om.recouped / om.total) * 1.5) {
      out.push({
        text: `**${pct(pr.recouped, pr.total)}** of commercial play revivals that opened from ${shortSeason(recoup.range[0])} to ${shortSeason(recoup.range[1])} have recouped (${pr.recouped} of ${pr.total}). For original musicals it's **${pct(om.recouped, om.total)}** (${om.recouped} of ${om.total}).`,
        href: '#who-recoups',
      });
    }
  }

  if (recoup.under60.total >= 10) {
    const n = recoup.under60.recouped;
    out.push({
      text: `${recoup.under60.total} commercial shows${recoup.range ? ` from ${shortSeason(recoup.range[0])} to ${shortSeason(recoup.range[1])}` : ''} scored under 60 with critics and have since closed or recouped. **${n === 0 ? 'None' : n === 1 ? 'One' : n}** recouped.`,
      href: '#who-recoups',
    });
  }
  return out;
}

export default function SeasonReportPage() {
  if (!featureFlags.seasonReport) notFound();

  const today = getMarketDate('broadway');
  const currentSeason = getSeason(today);
  const fullComparison = currentSeason ? getSeasonComparison(currentSeason) : null;
  // Public page: mix, pace and recoupment rows only; budgets and running costs stay on the held /biz.
  const comparison = fullComparison
    ? { ...fullComparison, rows: fullComparison.rows.filter((r) => r.format !== 'money' && !HIDDEN_ROW_LABELS.has(r.label)) }
    : null;
  const profiles = getSeasonProfiles();
  const cur = profiles.find((p) => p.season === currentSeason) ?? null;
  const { baseline, last: lastProfile } = currentSeason ? seasonBaseline(profiles, currentSeason) : { baseline: [], last: null };
  const mixColumns: MixColumn[] = [];
  if (cur) mixColumns.push({ label: `${shortSeason(cur.season)}${fullComparison?.inProgress ? ' so far' : ''}`, note: `${cur.productions} productions${fullComparison?.inProgress ? ', opened or announced' : ''}`, mix: mix(cur), seasons: 1, value: 'current' });
  if (lastProfile) mixColumns.push({ label: shortSeason(lastProfile.season), note: `${lastProfile.productions} productions`, mix: mix(lastProfile), seasons: 1, value: 'last' });
  if (baseline.length) mixColumns.push({ label: 'Prior seasons avg', note: `${baseline.length} seasons pooled`, mix: mix(...baseline), seasons: baseline.length, value: 'avg' });
  const pick = (labels: readonly string[]) => labels.map((l) => fullComparison?.rows.find((r) => r.label === l)).filter((r): r is NonNullable<typeof r> => !!r);
  const overallRows = pick(MIX_ROW_LABELS.slice(0, 2));
  const withinRows = pick(MIX_ROW_LABELS.slice(2));
  const history = selectSeasonHistory(profiles, currentSeason);
  const allShows = getAllShows();
  const scores = new Map(allShows.map((s) => [s.slug, s.compositeScore == null ? null : Math.round(s.compositeScore)]));
  const recoup = getRecoupFindings(scores, today);
  const findings = keyFindings(fullComparison, profiles, recoup, currentSeason, (season) => getSeasonComparison(season, today), cur);
  // The same shows the season profile counts, by mix group.
  const { dated: seasonShows, undated } = currentSeason ? getSeasonShowList(currentSeason) : { dated: [], undated: [] };
  const showGroups = SHOW_GROUPS.map((g) => ({ ...g, shows: seasonShows.filter((s) => showGroup(s.type, s.isRevival) === g.id) }))
    .filter((g) => g.shows.length > 0);
  const groupKind = new Map<string, string>(SHOW_GROUPS.map((g) => [g.id, g.one]));


  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Season Report', url: `${BASE_URL}/season-report` },
  ]);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <div className="min-h-screen bg-surface">
        <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
          <header className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Season Report</h1>
            <p className="text-gray-400 mt-2">
              {cur && currentSeason
                ? `${cur.productions} new Broadway productions have opened or been announced for ${shortSeason(currentSeason)}. We compare them with last season and the 10 before it, and track which kinds of shows earn their money back.`
                : 'This Broadway season compared with last season and the 10 before it, plus which kinds of shows earn their money back.'}
            </p>
            <p className="text-xs text-fg-muted mt-1" data-testid="season-report-asof">
              As of {formatDataDate(today) ?? today}. Updated as shows open, close and recoup.
            </p>
          </header>

          {findings.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-3">Highlights</h2>
              <ul className="card rounded-xl p-4 space-y-2 text-gray-300 list-disc list-inside" data-testid="season-report-findings">
                {findings.map((f) => <li key={f.text}><Finding item={f} /></li>)}
              </ul>
            </section>
          )}

          {comparison && (
            <section id="this-season" className="mb-8 scroll-mt-20">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="text-xl font-bold text-white">
                  {shortSeason(comparison.season)}{comparison.inProgress ? ' So Far' : ''}
                </h2>
                {seasonShows.length > 0 && <a href="#every-show" className="text-sm text-brand hover:text-brand-hover whitespace-nowrap">Every show &rarr;</a>}
              </div>
              <SeasonComparisonTable comparison={comparison} />
            </section>
          )}

          {mixColumns.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-1">Production Mix</h2>
              <p className="text-sm text-gray-400 mb-3">Originals and revivals, each split into musicals and plays. Each group links to its shows.</p>
              <MixCard columns={mixColumns} overallRows={overallRows} withinRows={withinRows} linkGroups={new Set(showGroups.map((g) => g.id))} />
            </section>
          )}

          {showGroups.length > 0 && currentSeason && (
            <section id="every-show" className="mb-8 scroll-mt-20" data-testid="season-show-list">
              <h2 className="text-xl font-bold text-white mb-1">Every {shortSeason(currentSeason)} Show</h2>
              <p className="text-sm text-gray-400 mb-3">
                {seasonShows.length === cur?.productions
                  ? `The ${seasonShows.length} productions counted above, opened or announced with a date.`
                  : `${seasonShows.length} productions opened or announced with a date.`}
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                {showGroups.map((g) => (
                  <div key={g.id} id={g.id} className="card rounded-xl p-4 scroll-mt-20">
                    <h3 className="text-white font-semibold mb-1">{g.label} <span className="text-fg-muted font-normal">({g.shows.length})</span></h3>
                    <ul className="text-sm">
                      {g.shows.map((show) => <ShowLine key={show.slug} show={show} today={today} />)}
                    </ul>
                  </div>
                ))}
                {undated.length > 0 && (
                  <div id="no-date-yet" className="card rounded-xl p-4 scroll-mt-20">
                    <h3 className="text-white font-semibold mb-1">Announced, no date yet <span className="text-fg-muted font-normal">({undated.length})</span></h3>
                    <p className="text-xs text-fg-muted mb-1">Not counted above until an opening date is set.</p>
                    <ul className="text-sm">
                      {undated.map((show) => (
                        <ShowLine key={show.slug} show={show} today={today} note={groupKind.get(showGroup(show.type, show.isRevival))} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          <section id="who-recoups" className="mb-8 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-3">Who Recoups</h2>
            <WhoRecoupsCard findings={recoup} />
            {featureFlags.pathToBroadway && (
              <p className="mt-3 text-sm text-gray-400">
                Recoupment by route to Broadway (Off-Broadway, London, straight in) and by source material is on{' '}
                <Link href="/path-to-broadway" className="text-brand hover:text-brand-hover">Path to Broadway</Link>.
              </p>
            )}
          </section>

          {history.length > 0 && (
            <section id="season-by-season" className="mb-8 scroll-mt-20">
              <h2 className="text-xl font-bold text-white mb-3">Season by Season</h2>
              <SeasonHistoryTable profiles={history} averageProfiles={selectSeasonAverageBase(profiles, currentSeason)} currentSeason={currentSeason} asOf={today} showCapital={false} linkSeasons={false} />
            </section>
          )}

          <section className="mb-8 text-sm text-gray-400" data-testid="season-report-definitions">
            <h2 className="text-base font-semibold text-white mb-1">How we count</h2>
            <p>
              A season runs July 1 to June 30, by opening night. A production is a new Broadway opening. A revival is a
              new production of a show that has played Broadway before. Commercial shows have investors to repay, so
              nonprofit-only runs and tour stops are left out of recoupment. A show has recouped once its producers say
              investors got their money back. Averages skip the pandemic seasons, 2019-20 and 2020-21.
            </p>
          </section>

          <footer className="text-sm text-fg-muted border-t border-white/5 pt-6">
            <p className="mb-2">
              Productions come from Broadway Scorecard&apos;s show database. Recoupment comes from producer
              announcements and trade press (Broadway Journal, Broadway News, Deadline, Variety, Playbill, The New York
              Times). Critic scores are Broadway Scorecard&apos;s weighted average of published reviews.
            </p>
            <p>
              Citing these figures? Credit &ldquo;Broadway Scorecard&rdquo; and link this page. Weekly grosses are on the{' '}
              <Link href="/box-office" className="text-brand hover:text-brand-hover">Box Office Scorecard</Link>; how critic
              scores work is on the <Link href="/methodology" className="text-brand hover:text-brand-hover">methodology page</Link>.
            </p>
          </footer>
        </div>
      </div>
    </>
  );
}
