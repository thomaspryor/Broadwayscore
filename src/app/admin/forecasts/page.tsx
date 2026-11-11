import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import { getShowById } from '@/lib/data';
import { getReviewForecastBoard, type BoardEntry } from '@/lib/admin-review-forecasts';
import { StatGrid, ScoreBadge, ShowListCard } from '@/components/show-cards';
import type { ShowCardShow } from '@/components/show-cards';

// Owner-only. Forecasts are private: this is a server-rendered page behind the admin cookie, with no
// API route, no static params and nothing under public/. Signed-out visitors get a plain 404.
// Layout matches the home page list: one ShowListCard per show, number on the right (here a labelled forecast).
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function cardShow(e: BoardEntry): ShowCardShow {
  const s = getShowById(e.showId);
  return {
    id: e.showId,
    slug: s?.slug ?? e.showId,
    title: e.title,
    venue: s?.venue ?? '',
    openingDate: e.openingDate,
    previewsStartDate: s?.previewsStartDate,
    status: e.state === 'upcoming' ? (s?.status === 'previews' ? 'previews' : 'upcoming') : (s?.status ?? 'open'),
    type: s?.type ?? 'musical',
    isRevival: s?.isRevival,
    category: s?.category,
    images: s?.images,
    audienceCombinedScore: null,
    audienceGrade: null,
  };
}

/** Right-hand box: same footprint as the home page score box, but dashed and captioned so it reads as a forecast, with its range and confidence beneath. */
function ForecastBox({ e }: { e: BoardEntry }) {
  const graded = e.state === 'graded';
  const conf = e.confidence ? { High: 'text-score-great', Medium: 'text-score-tepid', Low: 'text-score-skip' }[e.confidence] : 'text-fg-muted';
  return (
    <div className="flex-shrink-0 flex flex-col items-center justify-center gap-1.5 w-20 sm:w-24">
      <span className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap text-fg-muted">
        {graded ? 'Forecast was' : 'Forecast'}
      </span>
      <div className="rounded-xl outline outline-2 outline-dashed outline-offset-2 outline-white/30">
        <ScoreBadge score={e.forecast} size="lg" />
      </div>
      {e.lo80 != null && e.hi80 != null ? (
        <span className="text-xs font-semibold tabular-nums whitespace-nowrap text-gray-300" title="80% chance the Critic Score lands in this range">
          {e.lo80} to {e.hi80}
        </span>
      ) : null}
      {e.confidence ? (
        <span className={`text-[10px] font-semibold whitespace-nowrap ${conf}`} title={`Based on: ${e.confidenceBasis}`}>
          {e.confidence} confidence
        </span>
      ) : null}
      {e.forecastV2 != null ? (
        <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Newer model, tracked quietly beside the main forecast">
          v2 {e.forecastV2}
          {e.v2UsedShowScore ? '' : ' (same inputs)'}
        </span>
      ) : null}
    </div>
  );
}

function MetaLine({ e }: { e: BoardEntry }) {
  const aud = e.previewAudience != null ? `Audience ${Math.round(e.previewAudience)}${e.audienceCount ? ` (${e.audienceCount} votes)` : ''}` : 'No audience grade yet';
  const when = `${e.state === 'upcoming' ? 'Opens' : 'Opened'} ${fmtDate(e.openingDate)}`;
  return (
    <div className="text-sm text-gray-400 mt-2.5">
      <p>{when}</p>
      <p>{aud}</p>
      {e.confidenceBasis && e.confidenceBasis !== 'all inputs present' ? <p>Confidence limited by: {e.confidenceBasis}</p> : null}
      {e.state === 'graded' ? (
        <p className="text-fg mt-0.5">
          Critic Score {e.criticScore}
          {e.missForecast != null ? ` · missed by ${e.missForecast} pts` : ''}
          {e.inRange80 != null ? (e.inRange80 ? ' · inside range' : ' · outside range') : ''}
        </p>
      ) : e.state === 'awaiting-grade' ? (
        <p className="mt-0.5">Graded {fmtDate(e.gradeDueOn)}, once reviews settle</p>
      ) : null}
    </div>
  );
}

export default async function AdminForecastsPage() {
  if (!(await isAdmin())) notFound(); // plain 404, same as the other admin pages

  const board = await getReviewForecastBoard();
  const sections: Array<[string, BoardEntry['group']]> = [
    ['Opening soon', 'soon'],
    ['Later', 'later'],
    ['Graded', 'graded'],
  ];

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
        <header className="mb-5">
          <Link href="/admin" className="text-sm text-brand hover:underline">Admin</Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold mt-3">Review forecasts</h1>
          <p className="text-sm text-fg-muted mt-1">
            Our quiet forecast of each opening&apos;s Critic Score, recorded daily and frozen at opening night. Private.
          </p>
        </header>

        {'unavailable' in board ? (
          <p role="alert" className="card p-5 text-score-tepid">
            Forecasts are temporarily unavailable. Reload this page to try again.
          </p>
        ) : (
          <>
            <StatGrid
              className="mb-2"
              stats={[
                { label: 'Shows graded', value: board.summary.gradedShows },
                { label: 'Our typical miss', value: board.summary.ourMiss == null ? '–' : `${board.summary.ourMiss} pts`, dimmed: board.summary.ourMiss == null },
                { label: 'Category average miss', value: board.summary.categoryMiss == null ? '–' : `${board.summary.categoryMiss} pts`, dimmed: board.summary.categoryMiss == null },
              ]}
            />
            <p className="text-sm text-fg-muted mb-6">
              {board.summary.gradedShows === 0
                ? 'No show has been graded yet. Grades arrive 14 days after each opening.'
                : board.summary.early
                  ? `Only ${board.summary.gradedShows} graded so far, too early to call a winner. Smaller miss is better.`
                  : 'Smaller miss is better. Each miss is the average gap to the actual Critic Score.'}
            </p>
            {sections.map(([heading, group]) => {
              const rows = board.entries.filter((e) => e.group === group);
              if (rows.length === 0) return null;
              return (
                <section key={group} aria-label={heading} className="mb-6">
                  <h2 className="text-base font-bold text-white mb-3">{heading}</h2>
                  <div className="space-y-3" role="list" aria-label={heading}>
                    {rows.map((e, i) => (
                      <ShowListCard
                        key={e.showId}
                        show={cardShow(e)}
                        index={i}
                        scoreMode="critics"
                        scoreSlot={<ForecastBox e={e} />}
                        metaSlot={<MetaLine e={e} />}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {board.entries.length === 0 ? <p className="card p-5 text-fg-muted">No forecasts recorded yet.</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
