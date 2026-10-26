import { CostStatusPill } from '@/components/show-cards/CostStatusPill';
import WeeklyBarChart from '@/components/WeeklyBarChart';
import { PREVIEW_WEEKS, STATUS_WINDOW_WEEKS } from '@/lib/box-office-status';
import {
  type BoxOfficeV2Card,
  basisLine,
  costPill,
  coverTiles,
  formatShare,
  formatWeekly,
  nearNote,
  shareRangeText,
  showsBreakEven,
  streakText,
} from '@/lib/box-office-v2-display';

/**
 * The Profitability Scorecard's "Covering its weekly break-even?" section
 * (BRO-5007 v3): the last four weeks' gross as a share of the show's
 * break-even, the 52-week chart against the typical Broadway show, and what it
 * would take. Every number here leans on a cost estimate, which is why it sits
 * on the Commercial card and not the Box Office one. Unreleased; rendered only
 * when featureFlags.commercial && boxOfficeV2.
 */
const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400';

function Chart({ card }: { card: BoxOfficeV2Card }) {
  // Start at the show's first reported week: the weeks before it opened would
  // draw the typical-show line over an empty chart.
  const first = card.series.findIndex((p) => p.gross != null);
  const desktop = card.series.slice(Math.max(0, first));
  if (!desktop.some((p) => p.multiple != null)) return null;
  const phone = desktop.slice(-26);
  const label = 'Weekly gross as a share of its break-even, with the typical Broadway show for reference';
  return (
    <div className="bg-surface-overlay/60 rounded-xl px-2.5 sm:px-3.5 pt-3 pb-1.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={EYEBROW}>
          <span className="hidden sm:inline">Last {desktop.length} weeks · gross as a share of break-even</span>
          <span className="sm:hidden">Last {phone.length} weeks · share of break-even</span>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-gray-400">
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-status-open" />Above</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-score-tepid" />Below</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-0.5 bg-accent-cream" />Typical show</span>
        </div>
      </div>
      <div className="hidden sm:block"><WeeklyBarChart points={desktop} mode="multiple" label={label} /></div>
      <div className="sm:hidden"><WeeklyBarChart points={phone} mode="multiple" width={340} height={200} label={label} /></div>
    </div>
  );
}

function Early({ card }: { card: BoxOfficeV2Card }) {
  const filled = Math.min(card.weeksReported, PREVIEW_WEEKS);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <CostStatusPill pill={costPill(card)} />
        <span className="text-xs text-gray-400">{filled} of {STATUS_WINDOW_WEEKS} weeks</span>
      </div>
      <p className="m-0 text-sm leading-relaxed text-gray-300">
        This appears once the show has {STATUS_WINDOW_WEEKS} weeks of grosses. Preview weeks are often short, so early numbers swing.
      </p>
    </div>
  );
}

export default function BreakEvenSection({ card }: { card: BoxOfficeV2Card }) {
  if (!showsBreakEven(card)) return null;
  const m = card.multiple;
  const tiles = coverTiles(card.cover);
  const streak = streakText(card.streak);
  const near = nearNote(card);
  const basis = basisLine(card);
  const tilde = card.costBasis === 'reported' ? '' : '~';
  const streakTone = card.streak?.side === 'below' ? 'text-score-tepid' : 'text-status-open';
  return (
    <div className="rounded-xl border border-white/10 p-3.5 sm:p-4 flex flex-col gap-4" data-testid="break-even-section">
      <div className={EYEBROW}>Covering its weekly break-even?</div>
      {card.availability === 'early' || !m ? (
        <Early card={card} />
      ) : (
        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 items-start">
          <div className="flex flex-col gap-2 sm:min-w-[200px]">
            <div><CostStatusPill pill={costPill(card)} /></div>
            <div className="flex sm:flex-col items-baseline sm:items-start gap-2.5 sm:gap-2">
              <span className="text-[44px] sm:text-[48px] font-extrabold leading-none tracking-tight tabular-nums text-white">{formatShare(m.mid)}</span>
              <span className="text-xs text-gray-400 leading-snug">
                of the {tilde}{card.breakEven != null ? formatWeekly(card.breakEven) : ''} a week it needs to break even
                <br />last 4 weeks · <span className="whitespace-nowrap">could be {shareRangeText(m)}</span>
              </span>
            </div>
            {streak && <div className={`text-[13px] font-semibold ${streakTone}`}>{streak}</div>}
          </div>
          <div className="flex-1 flex flex-col gap-2.5">
            {card.story && <p className="m-0 text-[15px] leading-relaxed text-white">{card.story}</p>}
            {near && <p className="m-0 text-sm leading-relaxed text-gray-300">{near}</p>}
            {card.nonprofit && (
              <p className="m-0 text-sm leading-relaxed text-gray-300">
                {card.nonprofitOrg ? `${card.nonprofitOrg} is a nonprofit` : 'This is a nonprofit production'}: {card.noInvestors ? 'there are no investors to pay back, and ' : ''}nonprofits often cover part of the cost with donations and subscriptions, so grossing below break-even is less of a warning sign here.
              </p>
            )}
            {basis && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                <span className={`px-2 py-0.5 rounded-md border font-bold ${card.costBasis === 'reported' ? 'border-brand/45 text-brand-light' : 'border-white/20 text-gray-300'}`}>
                  {card.costBasis === 'reported' ? 'Reported' : 'Estimate'}
                </span>
                {card.costSourceUrl
                  ? <a href={card.costSourceUrl} target="_blank" rel="noopener noreferrer" className="text-gray-400 underline decoration-white/20 hover:text-brand">{basis}</a>
                  : <span>{basis}</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {card.availability === 'ok' && <Chart card={card} />}

      {tiles.length > 0 && (
        <>
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
        </>
      )}
    </div>
  );
}
