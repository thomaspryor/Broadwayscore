/**
 * /box-office stories below the market card (BRO-5007 v3, unreleased): the
 * week's movers, money per seat and the standouts. Server-rendered; the page
 * renders them only when featureFlags.commercial && boxOfficeV2.
 */
import type { ReactNode } from 'react';
import type { MarketPage, MoverRow } from '@/lib/box-office-display';
import { money, PACE_MIN_WEEK, PACE_MAX_WEEK, shortTitle } from '@/lib/box-office-display';
import { EYEBROW } from './MarketOverview';

const SECTION = 'card p-4 sm:p-6 mb-8 flex flex-col gap-4';
const H2 = 'm-0 text-xl font-bold text-white';

function MoverList({ title, rows, up }: { title: string; rows: MoverRow[]; up: boolean }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className={EYEBROW}>{title}</div>
      {rows.length ? (
        <ul className="m-0 p-0 list-none flex flex-col divide-y divide-white/5 bg-surface-overlay/60 rounded-xl px-3.5">
          {rows.map((m) => (
            <li key={m.slug} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold text-white truncate">{m.title}</span>
                <span className="block text-xs text-gray-400">{m.note}</span>
              </span>
              <span className="text-right shrink-0">
                <span className={`block text-[15px] font-bold tabular-nums ${up ? 'text-status-open' : 'text-score-tepid'}`}>
                  <span aria-hidden="true">{up ? '▲' : '▼'}</span>
                  <span className="sr-only">{up ? 'up ' : 'down '}</span>
                  {Math.round(Math.abs(m.pct))}%
                </span>
                <span className="block text-xs text-gray-400 tabular-nums">{money(m.gross)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-gray-400">None this week.</p>
      )}
    </div>
  );
}

export function MarketMovers({ movers }: { movers: MarketPage['movers'] }) {
  if (!movers.gains.length && !movers.drops.length) return null;
  return (
    <section className={SECTION} aria-labelledby="movers-heading">
      <h2 id="movers-heading" className="sr-only">This week’s movers</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MoverList title="Biggest gains this week" rows={movers.gains} up />
        <MoverList title="Biggest drops this week" rows={movers.drops} up={false} />
      </div>
      <p className="m-0 text-xs text-gray-400">
        Each move says whether the show played a different number of performances, the most common reason a gross jumps or dips.
      </p>
    </section>
  );
}

const PER_SEAT_SHOWN = 12;

export function PerSeatRanking({ perSeat }: { perSeat: MarketPage['perSeat'] }) {
  if (!perSeat.rows.length) return null;
  const tooNew = perSeat.tooNew.map((r) => `${r.title} ($${Math.round(r.perSeat)} so far)`);
  return (
    <section className={SECTION} aria-labelledby="per-seat-heading">
      <h2 id="per-seat-heading" className={H2}>Most money per seat</h2>
      <p className="m-0 text-sm leading-relaxed text-gray-300">
        Gross per seat: the week’s gross divided by every seat the show had to sell, averaged over 4 weeks. It levels the
        field between a 900-seat play and a 1,800-seat musical.{perSeat.jump ? ` ${perSeat.jump}` : ''}
      </p>
      <ol className="m-0 p-0 list-none grid grid-cols-1 md:grid-cols-2 gap-x-6">
        {perSeat.rows.slice(0, PER_SEAT_SHOWN).map((r, i) => (
          <li key={r.slug} className="flex items-center gap-3 py-2.5 border-b border-white/5">
            <span className="w-6 text-right text-sm font-bold text-gray-500 tabular-nums shrink-0">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-white truncate">{r.title}</span>
              <span className="block text-xs text-gray-400">
                #{r.grossRank} by gross{r.seats ? ` · ${r.seats.toLocaleString('en-US')} seats` : ''}
              </span>
            </span>
            <span className="text-[17px] font-bold text-white tabular-nums shrink-0">${Math.round(r.perSeat)}</span>
          </li>
        ))}
      </ol>
      {tooNew.length > 0 && (
        <p className="m-0 text-xs text-gray-400">Too new to rank (under 4 weeks): {tooNew.join(', ')}.</p>
      )}
      {perSeat.ranked > PER_SEAT_SHOWN && (
        <a href="#box-office-tables-heading" className="self-start text-sm text-brand hover:text-brand-hover min-h-[44px] sm:min-h-0 inline-flex items-center">
          See all {perSeat.ranked} shows →
        </a>
      )}
    </section>
  );
}

function StandoutList({ title, note, rows }: { title: string; note: string; rows: Array<{ key: string; name: string; isNew?: boolean; value: string }> }) {
  return (
    <div className="bg-surface-overlay/60 rounded-xl p-3.5 flex flex-col gap-2 min-w-0">
      <div className={EYEBROW}>{title}</div>
      <p className="m-0 text-xs text-gray-400 leading-snug">{note}</p>
      {rows.length ? (
        <ul className="m-0 p-0 list-none flex flex-col divide-y divide-white/5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm text-white truncate">
                {r.name}
                {r.isNew && <span className="ml-1.5 px-1.5 py-px rounded border border-white/20 text-[10px] font-bold uppercase text-gray-300 align-middle">new</span>}
              </span>
              <span className="text-sm font-bold text-white tabular-nums shrink-0">{r.value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-gray-400">None this week.</p>
      )}
    </div>
  );
}

const STANDOUTS_SHOWN = 5;

export function Standouts({ page }: { page: MarketPage }) {
  const median = page.premium.median;
  return (
    <section className={SECTION} aria-labelledby="standouts-heading">
      <h2 id="standouts-heading" className={H2}>Standouts</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <StandoutList
          title="Sell-out streaks"
          note="Straight weeks at 95% full or more"
          rows={page.streaks.slice(0, STANDOUTS_SHOWN).map((s) => ({ key: s.title, name: s.title, value: `${s.weeks} wks` }))}
        />
        <StandoutList
          title="Premium pull"
          note={median != null ? `Average ticket above the Broadway middle ($${Math.round(median)} this week)` : 'Average ticket above the Broadway middle'}
          rows={page.premium.rows.slice(0, STANDOUTS_SHOWN).map((p) => ({ key: p.title, name: p.title, isNew: p.isNew, value: `+$${Math.round(p.over)}` }))}
        />
        <NewShowsCompare pace={page.pace} />
      </div>
    </section>
  );
}

/**
 * How each new show's sales per seat rank against every Broadway run since
 * 2001 at the same week of its run: a 0-100 bar with a tick at the average.
 */
function NewShowsCompare({ pace }: { pace: MarketPage['pace'] }) {
  return (
    <div className="bg-surface-overlay/60 rounded-xl p-3.5 flex flex-col gap-2 min-w-0">
      <div className={EYEBROW}>How new shows compare</div>
      <p
        className="m-0 text-xs text-gray-400 leading-snug"
        title="Each week is first compared with how all of Broadway sold that week, so a busy holiday week does not flatter a new show."
      >
        Sales per seat so far, compared with every Broadway play and musical since 2001 at the same point in its run. 50% is a middle-of-the-pack show.
      </p>
      {pace.length ? (
        <ul className="m-0 p-0 list-none flex flex-col divide-y divide-white/5">
          {pace.map((p) => (
            <li key={p.title} className="flex flex-col gap-1 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-white truncate" title={p.title}>{shortTitle(p.title)}</span>
                <span className="text-sm font-bold text-white tabular-nums shrink-0">Better than {p.beatsPct}%</span>
              </div>
              <div className="relative h-1.5 rounded-full bg-white/10" aria-hidden="true">
                <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, p.beatsPct))}%` }} />
                <div className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-white/60" />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-gray-400">None this week.</p>
      )}
      <p className="m-0 text-xs text-gray-400">Shows {PACE_MIN_WEEK} to {PACE_MAX_WEEK} weeks into their run.</p>
    </div>
  );
}

export function PriceMapSection({ dots, children }: { dots: number; children: ReactNode }) {
  if (!dots) return null;
  return (
    <section className={SECTION} aria-labelledby="price-map-heading">
      <h2 id="price-map-heading" className={H2}>How full, and at what price?</h2>
      <p className="m-0 text-sm leading-relaxed text-gray-300">
        Each show by share of seats sold (across) and average ticket paid (up). A low average can mean discounts, but also
        cheaper seating or group sales. Bigger dots are bigger theaters. Top right is the place to be.
      </p>
      {children}
      <p className="m-0 text-xs text-gray-400">Capacity above 100% means standing room or extra seats were sold.</p>
    </section>
  );
}
