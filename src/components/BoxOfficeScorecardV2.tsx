import Link from 'next/link';
import type { ShowGrosses } from '@/lib/data-types';
import type { BoxOfficeHistoryStats } from '@/lib/data-grosses-history';
import { CostStatusPill } from '@/components/show-cards/CostStatusPill';
import BoxOfficeMultipleChart from '@/components/BoxOfficeMultipleChart';
import { BoxOfficeThisWeek } from '@/components/BoxOfficeStats';
import { formatCurrency } from '@/lib/formatting';
import { PREVIEW_WEEKS, STATUS_WINDOW_WEEKS } from '@/lib/box-office-status';
import {
  type BoxOfficeV2Card,
  basisLine,
  chartMode,
  costPill,
  coverTiles,
  formatMultiple,
  rangeText,
  streakText,
  trendText,
} from '@/lib/box-office-v2-display';

/**
 * Box Office Scorecard v2 (BRO-5007): gross against the show's weekly cost.
 * Unreleased; rendered only when featureFlags.commercial && boxOfficeV2 and
 * the page computed a status for this show.
 */
interface Props {
  card: BoxOfficeV2Card;
  grosses: ShowGrosses | null;
  weekEnding: string;
  history: BoxOfficeHistoryStats | null;
}

const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400';

function AllTimeFooter({ grosses }: { grosses: ShowGrosses | null }) {
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
        <a href="#commercial" className="text-brand hover:text-brand-hover min-h-[44px] sm:min-h-0 inline-flex items-center">Whole run: Commercial Scorecard ↓</a>
        <Link href="/box-office" className="text-brand hover:text-brand-hover min-h-[44px] sm:min-h-0 inline-flex items-center">All shows →</Link>
      </span>
    </div>
  );
}

function Chart({ card }: { card: BoxOfficeV2Card }) {
  const mode = chartMode(card.series);
  if (mode === 'none') return null;
  // Start at the show's first reported week: the weeks before it opened would
  // draw the typical-show line over an empty chart.
  const first = card.series.findIndex((p) => p.gross != null);
  const desktop = card.series.slice(Math.max(0, first));
  const phone = card.series.slice(-26);
  const title = mode === 'multiple' ? 'Gross as a multiple of its cost' : 'Weekly gross';
  const label = mode === 'multiple'
    ? 'Weekly gross as a multiple of its weekly cost, with the typical Broadway show for reference'
    : 'Weekly gross in dollars';
  return (
    <div className="bg-surface-overlay/60 rounded-xl px-2.5 sm:px-3.5 pt-3 pb-1.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={EYEBROW}>
          <span className="hidden sm:inline">Last {desktop.length} weeks · {title}</span>
          <span className="sm:hidden">Last {phone.length} weeks · {mode === 'multiple' ? '× its cost' : 'gross'}</span>
        </div>
        {mode === 'multiple' && (
          <div className="flex flex-wrap gap-3 text-xs text-gray-400">
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-status-open" />Above</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-score-tepid" />Below</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-0.5 bg-accent-cream" />Typical Broadway show</span>
          </div>
        )}
      </div>
      <div className="hidden sm:block"><BoxOfficeMultipleChart points={desktop} mode={mode} label={label} /></div>
      <div className="sm:hidden"><BoxOfficeMultipleChart points={phone} mode={mode} width={340} height={200} label={label} /></div>
    </div>
  );
}

function Headline({ card }: { card: BoxOfficeV2Card }) {
  const pill = costPill(card);
  const trend = trendText(card.trend);
  const streak = streakText(card.streak);
  const basis = basisLine(card);
  const streakTone = card.streak?.side === 'below' ? 'text-score-tepid' : 'text-status-open';

  if (card.availability === 'early') {
    const filled = Math.min(card.weeksReported, PREVIEW_WEEKS);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <CostStatusPill pill={pill} />
          <span className="text-xs text-gray-400">{filled} of {STATUS_WINDOW_WEEKS} weeks</span>
        </div>
        <p className="m-0 text-sm leading-relaxed text-gray-300">
          A status appears once it has {STATUS_WINDOW_WEEKS} weeks of grosses and a weekly cost. Preview weeks are often short, so early numbers swing.
        </p>
        <div className="grid grid-cols-4 gap-2" aria-hidden="true">
          {Array.from({ length: STATUS_WINDOW_WEEKS }, (_, i) => (
            <div
              key={i}
              className={`h-14 rounded-lg flex items-end justify-center pb-1.5 text-xs ${i < filled ? 'bg-brand/80 font-bold text-surface-raised' : 'border border-dashed border-white/20 text-gray-500'}`}
            >
              Wk {i + 1}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (card.availability === 'nocost') {
    return (
      <div className="flex flex-col gap-3">
        <div><CostStatusPill pill={pill} /></div>
        <p className="m-0 text-sm leading-relaxed text-gray-300">
          We haven’t found a reliable weekly cost for this show, so it gets no status. The weekly numbers below are exact.
        </p>
      </div>
    );
  }

  if (!card.multiple) {
    return (
      <div className="flex flex-col gap-3">
        <div><CostStatusPill pill={pill} /></div>
        {card.story && <p className="m-0 text-[15px] leading-relaxed text-white">{card.story}</p>}
      </div>
    );
  }

  const ofCost = card.costBasis === 'reported' ? 'of its reported weekly cost' : 'of its estimated weekly cost';
  return (
    <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 items-start">
      <div className="flex flex-col gap-2 sm:min-w-[200px]">
        <div className="flex items-center gap-2">
          <CostStatusPill pill={pill} />
          {trend && <span className="text-xs text-gray-400">{trend}</span>}
        </div>
        <div className="flex sm:flex-col items-baseline sm:items-start gap-2.5 sm:gap-2">
          <span className="text-[46px] sm:text-[52px] font-extrabold leading-none tracking-tight tabular-nums">{formatMultiple(card.multiple.mid)}</span>
          <span className="text-xs text-gray-400 leading-snug">
            {ofCost}<br />last 4 weeks · <span className="whitespace-nowrap">range {rangeText(card.multiple)}</span>
          </span>
        </div>
        {streak && <div className={`text-[13px] font-semibold ${streakTone}`}>{streak}</div>}
      </div>
      <div className="flex-1 flex flex-col gap-2.5">
        {card.story && <p className="m-0 text-[15px] leading-relaxed text-white">{card.story}</p>}
        {card.nonprofit && (
          <p className="m-0 text-sm leading-relaxed text-gray-300">
            {card.nonprofitOrg ? `${card.nonprofitOrg} is a nonprofit` : 'This is a nonprofit production'}: there are no investors to pay back, and nonprofits often cover part of the cost with donations and subscriptions, so grossing below cost is less of a warning sign here.
          </p>
        )}
        {basis && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span className={`px-2 py-0.5 rounded-md border font-bold ${card.costBasis === 'reported' ? 'border-brand/45 text-brand-light' : 'border-white/20 text-gray-300'}`}>
              {card.costBasis === 'reported' ? 'Reported' : 'Estimate'}
            </span>
            {card.costSourceUrl && card.costBasis === 'reported'
              ? <a href={card.costSourceUrl} target="_blank" rel="noopener noreferrer" className="text-gray-400 underline decoration-white/20 hover:text-brand">{basis}</a>
              : <span>{basis}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BoxOfficeScorecardV2({ card, grosses, weekEnding, history }: Props) {
  const tiles = coverTiles(card.cover);
  const rank = history?.rank ? ` · rank #${history.rank}` : '';
  return (
    <section className="card p-4 sm:p-6 mb-5 sm:mb-8 flex flex-col gap-5" aria-labelledby="box-office-v2-heading">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="box-office-v2-heading" className="m-0 text-[12px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none">Box Office Scorecard</h2>
          {weekEnding && <p className="m-0 text-xs italic text-gray-500">week of {weekEnding}{rank}<span className="hidden sm:inline">{rank ? ' on Broadway' : ''}</span></p>}
        </div>
        <span className="hidden sm:inline text-xs italic text-gray-500 shrink-0">source · Broadway League, public</span>
      </header>

      <Headline card={card} />

      {card.availability !== 'early' && <Chart card={card} />}

      {grosses && <BoxOfficeThisWeek grosses={grosses} history={history} className="" stackChanges />}

      {tiles.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className={EYEBROW}>What it would take to cover costs</div>
          <div className="hidden sm:grid grid-cols-3 gap-2.5">
            {tiles.map((t) => (
              <div key={t.label} className="bg-surface-overlay/60 rounded-xl p-3.5 flex flex-col gap-1">
                <div className="text-xs text-gray-400">{t.label}</div>
                <div className="text-[22px] font-extrabold text-white">{t.value}</div>
                {t.detail && <div className="text-xs text-gray-400">{t.detail}</div>}
              </div>
            ))}
          </div>
          <div className="sm:hidden bg-surface-overlay/60 rounded-xl px-3.5 divide-y divide-white/5">
            {tiles.map((t) => (
              <div key={t.label} className="flex justify-between items-baseline gap-3 py-2.5">
                <span className="text-[13px] text-gray-400">{t.phoneLabel}<span className="block text-xs">{t.phoneDetail}</span></span>
                <span className="text-[15px] font-bold text-white whitespace-nowrap">{t.phoneValue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <AllTimeFooter grosses={grosses} />
    </section>
  );
}
