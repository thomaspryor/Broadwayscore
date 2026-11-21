/**
 * /biz "Who is covering their costs" (BRO-5007 v3, unreleased): running
 * Broadway shows grouped by how this month's grosses compare with their
 * estimated weekly break-even, each with its share of break-even. Moved here from
 * /box-office, which now sticks to published figures. Server-rendered; the
 * page renders it only when featureFlags.commercial && boxOfficeV2.
 */
import Link from 'next/link';
import { formatShare, type PillTone, type StatusCounts } from '@/lib/box-office-v2-display';

const TONE_TEXT: Record<PillTone, string> = {
  above: 'text-status-open',
  near: 'text-gray-300',
  below: 'text-score-tepid',
  muted: 'text-gray-400',
  pending: 'text-fg-muted',
};

function list(titles: string[], max = 3): string {
  if (titles.length <= max) return titles.join(', ');
  return `${titles.slice(0, max).join(', ')} and ${titles.length - max} more`;
}

function notRatedLine(c: StatusCounts): string | null {
  const parts: string[] = [];
  if (c.noEstimate.length) parts.push(`${c.noEstimate.length} without a cost estimate yet (${list(c.noEstimate)})`);
  if (c.nonprofitNoEstimate.length) parts.push(`${c.nonprofitNoEstimate.length} nonprofit ${c.nonprofitNoEstimate.length === 1 ? 'production' : 'productions'} with no published cost (${list(c.nonprofitNoEstimate)})`);
  if (c.early.length) parts.push(`${c.early.length} too early to tell (${list(c.early)})`);
  if (c.closing.length) parts.push(`${c.closing.length} in ${c.closing.length === 1 ? 'its' : 'their'} final weeks (${list(c.closing)})`);
  if (!parts.length) return null;
  const last = parts.pop()!;
  return `Not rated: ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

/** `shares`: title → last 4 weeks' gross over estimated break-even (1.0 = covering costs). */
export default function CostCoverageCard({ counts, shares }: { counts: StatusCounts; shares: Record<string, number> }) {
  if (!counts.rated) return null;
  const notRated = notRatedLine(counts);
  return (
    <section className="mb-10" aria-labelledby="cost-coverage-heading">
      <h2 id="cost-coverage-heading" className="text-xl font-bold text-white mb-2">Who is covering their costs</h2>
      <p className="text-gray-400 text-sm mb-4">
        Each running show&apos;s last 4 weeks of grosses as a share of our estimate of its weekly break-even. 100%
        means just covering its costs. Bands also weigh how sure each estimate is, so similar shares can land in
        different bands. Estimates, not reported figures.{' '}
        <Link href="/methodology#commercial" className="text-brand hover:underline">How we estimate break-even</Link>
      </p>
      <div className="card p-4 sm:p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-5">
          {counts.groups.map((g) => (
            <div key={g.band} className="min-w-0">
              <p className={`text-sm font-bold ${TONE_TEXT[g.tone]}`}>
                {g.titles.length} {g.label}
              </p>
              {g.titles.length ? (
                <ul className="mt-1.5 m-0 p-0 list-none flex flex-col gap-1">
                  {[...g.titles].sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0)).map((t) => (
                    <li key={t} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-gray-300 min-w-0 truncate">{t}</span>
                      {shares[t] != null && <span className="text-gray-400 tabular-nums shrink-0">{formatShare(shares[t])}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-sm text-fg-muted">None</p>
              )}
            </div>
          ))}
        </div>
        {notRated && <p className="mt-5 pt-4 border-t border-white/10 text-xs text-fg-muted">{notRated}</p>}
      </div>
    </section>
  );
}
