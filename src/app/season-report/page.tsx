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
import { getSeason, getSeasonComparison, getSeasonProfiles, getRecoupFindings } from '@/lib/data-commercial';
import { getMarketDate } from '@/lib/date-utils';
import { formatDataDate } from '@/lib/biz-format';
import { BASE_URL, SITE_OG_IMAGE, generateBreadcrumbSchema } from '@/lib/seo';
import { MIX_ROW_LABELS, MIX_ROW_LABELS_HIDDEN, mix, seasonBaseline, type RecoupFindings, type SeasonComparison, type SeasonProfile } from '@/lib/season-profile';

import SeasonComparisonTable from '@/components/biz/SeasonComparisonTable';
import SeasonHistoryTable from '@/components/biz/SeasonHistoryTable';
import WhoRecoupsCard from '@/components/biz/WhoRecoupsCard';
import MixCard, { type MixColumn } from '@/components/biz/MixCard';

export const metadata: Metadata = {
  title: 'Broadway Season Report: Openings, Revivals and Who Recoups',
  description:
    'How the current Broadway season compares with last season and the prior 10: shows opened, plays vs musicals, revivals, and which kinds of shows recoup.',
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

/** A finding with **figures** marked for bold; rendered by <Finding>. */
function Finding({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i} className="font-semibold text-white">{part}</strong> : part))}</>;
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
): string[] {
  const out: string[] = [];
  const opened = comparison?.rows.find((r) => r.label === 'Opened so far');
  if (comparison?.inProgress && opened?.current != null && opened.last != null && comparison.lastSeason) {
    const avg = opened.avg != null ? ` (average for this point: ${opened.avg.toFixed(1)})` : '';
    out.push(`**${opened.current}** new Broadway ${opened.current === 1 ? 'production has' : 'productions have'} opened so far this season, against **${opened.last}** at this point in ${shortSeason(comparison.lastSeason)}${avg}.`);
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
    const vs = avg?.avg != null ? `, against ${Math.round(avg.avg * 100)}% across the 10 seasons before it (pandemic seasons left out)` : '';
    const rankText = rank === 1 && !tied
      ? `the highest in our records, which go back to ${shortSeason(oldest)}${runnerUp ? ` (next highest: ${pct(runnerUp.revivals, runnerUp.revivalKnown)} in ${shortSeason(runnerUp.season)})` : ''}`
      : `${tied ? 'tied for ' : ''}the ${rank === 1 ? '' : `${ordinal(rank)} `}highest of the ${ranked.length} seasons in our records, back to ${shortSeason(oldest)}`;
    out.push(`Revivals were **${pct(last.revivals, last.revivalKnown)}** of ${shortSeason(last.season)}'s new productions${vs}: ${rankText}.`);
  }

  const by = Object.fromEntries(recoup.buckets.map((b) => [b.label, b]));
  const pr = by['Play revivals'];
  const om = by['Original musicals'];
  if (pr && om && pr.total >= 10 && om.total >= 10 && om.recouped > 0 && recoup.range) {
    // State the two rates with their counts: a single "N times" multiple rests on a handful of
    // recoupments and overstates its precision (review, BRO-5777).
    if (pr.recouped / pr.total > (om.recouped / om.total) * 1.5) {
      out.push(`For shows that opened ${shortSeason(recoup.range[0])} to ${shortSeason(recoup.range[1])}, **${pct(pr.recouped, pr.total)}** of commercial play revivals have recouped (${pr.recouped} of ${pr.total}), against **${pct(om.recouped, om.total)}** of original musicals (${om.recouped} of ${om.total}).`);
    }
  }

  if (recoup.under60.total >= 10) {
    out.push(`Of ${recoup.under60.total} commercial shows from ${recoup.range ? `${shortSeason(recoup.range[0])} to ${shortSeason(recoup.range[1])}` : 'recent seasons'} that scored under 60 with critics and have since closed or recouped, **${recoup.under60.recouped === 0 ? 'none' : recoup.under60.recouped === 1 ? 'one' : recoup.under60.recouped}** recouped.`);
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
  if (cur) mixColumns.push({ label: `${shortSeason(cur.season)}${fullComparison?.inProgress ? ' so far' : ''}`, note: `${cur.productions} productions${fullComparison?.inProgress ? ', opened or announced' : ''}`, mix: mix(cur), showCounts: true, value: 'current' });
  if (lastProfile) mixColumns.push({ label: shortSeason(lastProfile.season), note: `${lastProfile.productions} productions`, mix: mix(lastProfile), showCounts: true, value: 'last' });
  if (baseline.length) mixColumns.push({ label: 'Prior seasons avg', note: `${baseline.length} seasons pooled`, mix: mix(...baseline), showCounts: false, value: 'avg' });
  const pick = (labels: readonly string[]) => labels.map((l) => fullComparison?.rows.find((r) => r.label === l)).filter((r): r is NonNullable<typeof r> => !!r);
  const overallRows = pick(MIX_ROW_LABELS.slice(0, 2));
  const withinRows = pick(MIX_ROW_LABELS.slice(2));
  const history = profiles.filter((p) => !currentSeason || p.season <= currentSeason).slice(0, 11);
  const scores = new Map(getAllShows().map((s) => [s.slug, s.compositeScore == null ? null : Math.round(s.compositeScore)]));
  const recoup = getRecoupFindings(scores, today);
  const findings = keyFindings(fullComparison, profiles, recoup, currentSeason, (season) => getSeasonComparison(season, today));

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
              {currentSeason ? `The ${currentSeason} season` : 'This season'} against last season and the 10 before it:
              what opened, how much of it was revivals, and which kinds of shows pay back their investors.
            </p>
            <p className="text-xs text-gray-500 mt-1" data-testid="season-report-asof">
              As of {formatDataDate(today) ?? today}. Updated as shows open, close and recoup.
            </p>
          </header>

          {findings.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-3">Key Findings</h2>
              <ul className="card rounded-xl p-4 space-y-2 text-gray-300 list-disc list-inside" data-testid="season-report-findings">
                {findings.map((f) => <li key={f}><Finding text={f} /></li>)}
              </ul>
            </section>
          )}

          {comparison && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-3">
                The {comparison.season} Season{comparison.inProgress ? ' So Far' : ''}
              </h2>
              <SeasonComparisonTable comparison={comparison} />
            </section>
          )}

          {mixColumns.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-1">Production Mix</h2>
              <p className="text-sm text-gray-400 mb-3">Originals and revivals, each split into musicals and plays.</p>
              <MixCard columns={mixColumns} overallRows={overallRows} withinRows={withinRows} />
            </section>
          )}

          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-3">Who Recoups</h2>
            <WhoRecoupsCard findings={recoup} />
          </section>

          {history.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-bold text-white mb-3">Season by Season</h2>
              <SeasonHistoryTable profiles={history} currentSeason={currentSeason} showCapital={false} linkSeasons={false} />
            </section>
          )}

          <section className="mb-8 text-sm text-gray-400" data-testid="season-report-definitions">
            <h2 className="text-base font-semibold text-white mb-1">How we count</h2>
            <p>
              A season runs July 1 to June 30 by opening night. A production is a new Broadway opening; a revival is a
              new production of a show seen on Broadway before. &ldquo;Commercial&rdquo; shows have investors to repay
              (nonprofit-only runs and tour stops are left out), and a show has recouped when its producers report that
              investors got their money back. Averages leave out the pandemic seasons 2019-20 and 2020-21.
            </p>
          </section>

          <footer className="text-sm text-gray-500 border-t border-white/5 pt-6">
            <p className="mb-2">
              Productions are new Broadway openings from Broadway Scorecard&apos;s show database. Recoupment comes from
              producer announcements and trade press (Broadway Journal, Broadway News, Deadline, Variety, Playbill, The
              New York Times). Critic scores are Broadway Scorecard&apos;s weighted average of published reviews.
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
