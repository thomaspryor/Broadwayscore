import Link from 'next/link';
import type { ShowGrosses } from '@/lib/data-types';
import type { BoxOfficeHistoryStats } from '@/lib/data-grosses-history';
import WeeklyBarChart from '@/components/WeeklyBarChart';
import { BoxOfficeThisWeek } from '@/components/BoxOfficeStats';
import { formatCurrency } from '@/lib/formatting';
import { type BoxOfficeFactsCard, type BestLine, formatGross } from '@/lib/box-office-v2-display';

/**
 * Box Office Scorecard v3 (BRO-5007): "how are ticket sales?", from public
 * Broadway League numbers only. Everything that needs a cost estimate lives in
 * the Profitability Scorecard's break-even section. Unreleased; rendered only when
 * featureFlags.commercial && boxOfficeV2.
 */
interface Props {
  card: BoxOfficeFactsCard;
  grosses: ShowGrosses | null;
  history: BoxOfficeHistoryStats | null;
}

const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400';
const PHONE_WEEKS = 26;

function weekLabel(week: string): string {
  const [y, m, d] = week.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

function AllTimeFooter({ grosses, hasCommercial }: { grosses: ShowGrosses | null; hasCommercial: boolean }) {
  const a = grosses?.allTime;
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 border-t border-white/10 pt-3.5 text-[13px] text-gray-400">
      {a && a.gross != null ? (
        <span>
          All time: <span className="text-white font-semibold">{formatCurrency(a.gross)}</span> gross
          {a.performances != null && <> · <span className="text-white font-semibold">{a.performances.toLocaleString()}</span> performances</>}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-x-4">
        {hasCommercial && (
          <a href="#commercial" className="text-brand hover:text-brand-hover min-h-[44px] sm:min-h-0 inline-flex items-center">Is it covering its costs? ↓</a>
        )}
        <Link href="/box-office" className="text-brand hover:text-brand-hover min-h-[44px] sm:min-h-0 inline-flex items-center">All shows →</Link>
      </span>
    </div>
  );
}

/** Last 26 weeks on phones with a CSS-only button for the full year (no hydration flash); the full span on wider screens. */
function Chart({ card }: { card: BoxOfficeFactsCard }) {
  const points = card.series.map((p) => ({ week: p.week, gross: p.gross, multiple: null, market: null }));
  if (!points.some((p) => p.gross != null)) return null;
  const phone = points.slice(-PHONE_WEEKS);
  const canExpand = points.length > PHONE_WEEKS;
  const toggleId = `bo-full-year-${card.week}`;
  const label = `Weekly gross in dollars, last ${points.length} weeks`;
  return (
    <div className="bg-surface-overlay/60 rounded-xl px-2.5 sm:px-3.5 pt-3 pb-1.5 flex flex-col gap-2">
      {canExpand && <input type="checkbox" id={toggleId} className="peer sr-only" />}
      <div className={`${EYEBROW} hidden sm:block`}>Last {points.length} weeks · weekly gross</div>
      <div className={`${EYEBROW} sm:hidden peer-checked:hidden`}>Last {phone.length} weeks · weekly gross</div>
      {canExpand && <div className={`${EYEBROW} hidden peer-checked:block sm:peer-checked:hidden`}>Last {points.length} weeks · weekly gross</div>}
      <div className="hidden sm:block"><WeeklyBarChart points={points} mode="gross" label={label} /></div>
      <div className="sm:hidden peer-checked:hidden"><WeeklyBarChart points={phone} mode="gross" width={340} height={200} label={`Weekly gross in dollars, last ${phone.length} weeks`} /></div>
      {canExpand && (
        <>
          <div className="hidden peer-checked:block sm:peer-checked:hidden"><WeeklyBarChart points={points} mode="gross" width={340} height={200} label={label} /></div>
          <label htmlFor={toggleId} className="sm:hidden peer-checked:hidden self-start min-h-[44px] inline-flex items-center text-[13px] text-brand cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-brand rounded">
            Show the full year
          </label>
          <label htmlFor={toggleId} className="hidden peer-checked:inline-flex sm:peer-checked:hidden self-start min-h-[44px] items-center text-[13px] text-brand cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-brand rounded">
            Show the last {PHONE_WEEKS} weeks
          </label>
        </>
      )}
    </div>
  );
}

/** This run's records, Broadway League figures only; hidden under four reported weeks. */
function PersonalBests({ lines }: { lines: BestLine[] }) {
  return (
    <section className="bg-surface-overlay/60 rounded-xl p-3.5 flex flex-col gap-2" aria-labelledby="personal-bests-heading">
      <h3 id="personal-bests-heading" className={`${EYEBROW} m-0`}>Personal bests · this run</h3>
      <ul className="m-0 p-0 list-none flex flex-col divide-y divide-white/5">
        {lines.map((l) => (
          <li key={l.label} className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-3 py-2">
            <span className="text-sm text-gray-300">{l.label}</span>
            <span className="text-sm text-white sm:text-right">
              <span className="font-bold tabular-nums">{l.value}</span>
              <span className="text-gray-400"> · {l.when}</span>
              {l.latest && (
                l.isNew
                  ? <span className="block sm:inline mt-1 sm:mt-0 sm:ml-1.5"><span className="px-1.5 py-px rounded border border-white/20 text-[11px] font-bold text-gray-200 whitespace-nowrap">{l.latest}</span></span>
                  : <span className="block sm:inline text-gray-400 tabular-nums"><span className="hidden sm:inline"> · </span>{l.latest}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs text-fg-muted">This production only. Dollars at the time, not adjusted for inflation.</p>
    </section>
  );
}

export default function BoxOfficeScorecard({ card, grosses, history }: Props) {
  return (
    <section className="card p-4 sm:p-6 mb-5 sm:mb-8 flex flex-col gap-5" aria-labelledby="box-office-heading">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="box-office-heading" className="m-0 text-[12px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none">Box Office Scorecard</h2>
          <p className="m-0 text-xs italic text-fg-muted">{card.current ? 'week of' : 'last reported week:'} {weekLabel(card.week)}</p>
        </div>
        <span className="text-xs italic text-fg-muted shrink-0">source · Broadway League, public</span>
      </header>

      <div className="flex flex-col sm:flex-row gap-3 sm:gap-6 items-start">
        <div className="flex flex-col gap-1 sm:min-w-[180px]">
          <span className="text-[46px] sm:text-[52px] font-extrabold leading-none tracking-tight tabular-nums text-white">{formatGross(card.gross)}</span>
          <span className="text-xs text-gray-400">
            {card.current ? 'gross this week' : 'gross that week'}{card.rank > 0 && card.of > 0 ? <> · #{card.rank} of {card.of} shows</> : null}
          </span>
        </div>
        {card.story && <p className="m-0 flex-1 text-[15px] leading-relaxed text-white">{card.story}</p>}
      </div>

      <Chart card={card} />

      {grosses && <BoxOfficeThisWeek grosses={grosses} history={history} className="" stackChanges roundNearest />}

      {card.bests && <PersonalBests lines={card.bests} />}

      <AllTimeFooter grosses={grosses} hasCommercial={card.hasCommercial} />
    </section>
  );
}
