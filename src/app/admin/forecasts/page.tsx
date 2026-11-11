import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import { getReviewForecastBoard, type BoardEntry } from '@/lib/admin-review-forecasts';
import { StatGrid, StatusBadge, ScoreBadge } from '@/components/show-cards';

// Owner-only. Forecasts are private: this is a server-rendered page behind the admin cookie, with no
// API route, no static params and nothing under public/. Signed-out visitors get a plain 404.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const pts = (n: number | null) => (n == null ? '–' : `${n} pts`);

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-muted text-xs">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function ShowRow({ e }: { e: BoardEntry }) {
  const status = e.state === 'upcoming' ? 'upcoming' : 'open';
  const range = e.lo80 != null && e.hi80 != null ? `${e.lo80} to ${e.hi80}` : '–';
  return (
    <li className="card p-4">
      <div className="flex items-start gap-3">
        <ScoreBadge score={e.forecast} size="xs" />
        <div className="min-w-0 flex-1">
          <h3 className="font-bold break-words [overflow-wrap:anywhere]">{e.title}</h3>
          <p className="text-sm text-fg-muted mt-0.5">
            {e.state === 'upcoming' ? 'Opens' : 'Opened'} <time dateTime={e.openingDate}>{fmtDate(e.openingDate)}</time>
          </p>
        </div>
        {e.state === 'upcoming' ? <StatusBadge status={status} /> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-sm">
        <Fact label="Our forecast" value={e.forecast == null ? '–' : String(e.forecast)} />
        <Fact label="Likely range" value={range} />
        <Fact label="Category average" value={e.categoryMean == null ? '–' : String(Math.round(e.categoryMean))} />
        <Fact
          label="Preview audience grade"
          value={e.previewAudience == null ? 'none yet' : `${Math.round(e.previewAudience)} (${e.audienceCount} votes)`}
        />
        {e.state === 'graded' ? (
          <>
            <Fact label="Actual Critic Score" value={String(e.criticScore)} />
            <Fact label="In likely range" value={e.inRange80 == null ? '–' : e.inRange80 ? 'Yes' : 'No'} />
            <Fact label="Our miss" value={pts(e.missForecast)} />
            <Fact label="Category average miss" value={pts(e.missCategoryMean)} />
          </>
        ) : null}
      </dl>
      <p className="text-xs text-fg-muted mt-3">
        {e.state === 'graded'
          ? `Forecast frozen ${e.forecastRecordedAt ? fmtDate(e.forecastRecordedAt) : 'before opening'}.`
          : e.state === 'awaiting-grade'
            ? `Frozen before opening. Graded on ${fmtDate(e.gradeDueOn)}, once reviews settle.`
            : `Latest forecast${e.forecastRecordedAt ? `, recorded ${fmtDate(e.forecastRecordedAt)}` : ''}. Freezes at opening night.`}
      </p>
    </li>
  );
}

export default async function AdminForecastsPage() {
  if (!(await isAdmin())) notFound(); // plain 404, same as the other admin pages

  const board = await getReviewForecastBoard();
  const sections: Array<[string, BoardEntry['state']]> = [
    ['Upcoming', 'upcoming'],
    ['Opened, waiting for the grade', 'awaiting-grade'],
    ['Graded', 'graded'],
  ];

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <Link href="/admin" className="text-sm text-brand hover:underline">Admin</Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold mt-3">Review forecasts</h1>
          <p className="text-sm text-fg-muted mt-1">
            Our quiet forecast of each Broadway opening&apos;s Critic Score, recorded daily and frozen at opening night.
            Private. Refreshes itself every few minutes.
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
                { label: 'Upcoming', value: board.summary.upcomingShows, subtitle: `${board.summary.awaitingGrade} awaiting grade` },
              ]}
            />
            <p className="text-sm text-fg-muted mb-6">
              {board.summary.gradedShows === 0
                ? 'No show has been graded yet. Grades arrive 14 days after each opening.'
                : board.summary.early
                  ? `Only ${board.summary.gradedShows} graded so far, too early to call a winner. Smaller miss is better.`
                  : 'Smaller miss is better. Each miss is the average gap to the actual Critic Score.'}
            </p>
            {sections.map(([heading, state]) => {
              const rows = board.entries.filter((e) => e.state === state);
              if (rows.length === 0) return null;
              return (
                <section key={state} aria-label={heading} className="mb-8">
                  <h2 className="text-lg font-bold mb-3">
                    {heading} <span className="text-sm text-fg-muted font-normal">({rows.length})</span>
                  </h2>
                  <ul className="grid gap-3 md:grid-cols-2">
                    {rows.map((e) => <ShowRow key={e.showId} e={e} />)}
                  </ul>
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
