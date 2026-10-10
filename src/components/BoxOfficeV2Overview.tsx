/**
 * /box-office header card (BRO-5007 Phase 3, unreleased): the market this
 * week and who is covering their costs. Server-rendered; the page renders it
 * only when featureFlags.commercial && boxOfficeV2.
 */
import type { MarketLine, PillTone, StatusCounts } from '@/lib/box-office-v2-display';

const TONE_TEXT: Record<PillTone, string> = {
  above: 'text-status-open',
  near: 'text-gray-300',
  below: 'text-score-tepid',
  muted: 'text-gray-400',
  pending: 'text-gray-500',
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

export default function BoxOfficeV2Overview({ market, counts }: { market: MarketLine | null; counts: StatusCounts }) {
  const notRated = notRatedLine(counts);
  return (
    <section className="card p-4 sm:p-6 mb-10" aria-label="The market this week">
      {market && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">The market this week</p>
          <p className="mt-2 text-lg sm:text-xl text-white leading-snug">
            Broadway grossed <strong>{market.gross}</strong>
            {market.direction && market.lastYearGross ? (
              market.direction === 'flat' ? (
                <>, about the same as the same week last year ({market.lastYearGross})</>
              ) : (
                <>
                  , {market.direction}{' '}
                  <strong className={market.direction === 'down' ? 'text-score-tepid' : 'text-status-open'}>{market.changePct}%</strong>{' '}
                  from the same week last year ({market.lastYearGross})
                </>
              )
            ) : null}
            , with {market.shows} shows running{market.lastYearShows != null ? <> versus {market.lastYearShows}</> : null}.
          </p>
        </div>
      )}
      {counts.rated > 0 && (
        <div className={market ? 'mt-5 pt-5 border-t border-white/10' : ''}>
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Who is covering their costs · {counts.rated} shows with a cost estimate · last 4 weeks
          </p>
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
            {counts.groups.map((g) => (
              <div key={g.band} className="min-w-0">
                <p className={`text-sm font-bold ${TONE_TEXT[g.tone]}`}>
                  {g.titles.length} {g.label}
                </p>
                <p className="mt-1 text-sm text-gray-400 leading-snug">{g.titles.length ? g.titles.join(', ') : 'None'}</p>
              </div>
            ))}
          </div>
          {notRated && <p className="mt-4 text-xs text-gray-500">{notRated}</p>}
        </div>
      )}
    </section>
  );
}
