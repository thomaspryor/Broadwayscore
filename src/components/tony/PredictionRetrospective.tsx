/**
 * Post-ceremony retrospective: how every public predictor did against the
 * announced winners — our model, the prediction markets (Kalshi/Polymarket),
 * Gold Derby's three panels, the press "will win" picks, the Beat the Critics
 * panel, and our players' consensus.
 *
 * Data is a frozen per-ceremony snapshot in data/tony-prediction-retrospectives.json
 * (keyed by ceremony year). Pre-ceremony market prices there were recovered from
 * the odds-poller git history at market close, so post-ceremony resolution
 * (markets settling to 99¢) can never leak into the displayed numbers.
 * Renders nothing for seasons without an entry.
 */
import { Fragment } from 'react';
import retrospectives from '../../../data/tony-prediction-retrospectives.json';

interface BigFourRow {
  name: string;
  org: string | null;
  group?: string;
  picks: (string | null)[];
  hits: (boolean | null)[];
}

interface LeaderboardEntry {
  name: string;
  org: string | null;
  group?: string;
  correct: number;
  attempted: number;
  highlight?: boolean;
}

interface Upset {
  tag: string;
  title: string;
  body: string;
}

interface MarketMove {
  category: string;
  from: string;
  to: string;
  verdict: 'right' | 'wrong';
  note: string;
}

interface Retrospective {
  asOf: string;
  bigFour: { categories: string[]; winners: string[]; rows: BigFourRow[] };
  leaderboard: LeaderboardEntry[];
  leaderboardNote: string;
  upsets: Upset[];
  marketMoves?: { title: string; subtitle: string; rows: MarketMove[] };
  btc: { players?: number; avgScore: number; totalCategories: number; beatAllThreePct: number; topScore: number; consensusScore?: number };
}

export function getRetrospective(ceremonyYear: number): Retrospective | null {
  const data = retrospectives as Record<string, Retrospective>;
  return data[String(ceremonyYear)] ?? null;
}

function HitPill({ pick, hit }: { pick: string | null; hit: boolean | null }) {
  if (pick === null) {
    return <span className="text-[11px] text-gray-600">no market</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${
        hit ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
      }`}
    >
      <span aria-hidden="true" className="font-bold">{hit ? '✓' : '✗'}</span>
      {pick}
    </span>
  );
}

export function PredictionRetrospective({ ceremonyYear }: { ceremonyYear: number }) {
  const retro = getRetrospective(ceremonyYear);
  if (!retro) return null;

  return (
    <section className="mb-10">
      <div className="flex items-baseline justify-between gap-3 mb-1 flex-wrap">
        <h2 className="text-lg font-bold text-white">Who Called the {ceremonyYear} Tonys?</h2>
        <span className="text-[11px] text-gray-500">final pre-ceremony picks vs. the winners</span>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        How every public predictor did: our model, the prediction markets, Gold Derby&apos;s three
        panels, the press, and the <a href="/beat-the-critics" className="text-brand hover:text-brand-light">Beat the Critics</a> panel.
      </p>

      {/* Big Four grid */}
      <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5 mb-4 overflow-x-auto">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">The Big Four</h3>
        <table className="w-full text-left min-w-[640px]">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide py-2 pr-2">Predictor</th>
              {retro.bigFour.categories.map((cat, i) => (
                <th key={cat} className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide py-2 px-2 text-center">
                  <span className="block">{cat.replace('Best ', '').replace('Revival of a ', 'Revival / ')}</span>
                  <span className="block text-gray-600 normal-case font-normal">won: {retro.bigFour.winners[i]}</span>
                </th>
              ))}
              <th className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide py-2 pl-2 text-center">Score</th>
            </tr>
          </thead>
          <tbody>
            {retro.bigFour.rows.map((row, idx) => {
              const score = row.hits.filter(h => h === true).length;
              const attempted = row.hits.filter(h => h !== null).length;
              const perfect = score === attempted && attempted >= 4;
              const showGroup = !!row.group && row.group !== retro.bigFour.rows[idx - 1]?.group;
              const colSpan = retro.bigFour.categories.length + 2;
              return (
                <Fragment key={row.name}>
                  {showGroup && (
                    <tr>
                      <td colSpan={colSpan} className="pt-3 pb-1">
                        <span className="text-[10px] font-bold text-brand/80 uppercase tracking-[0.14em]">{row.group}</span>
                      </td>
                    </tr>
                  )}
                  <tr className={`border-b border-white/5 ${perfect ? 'bg-brand/[0.04]' : ''}`}>
                    <td className="py-2 pr-2 pl-2">
                      <span className="text-sm font-medium text-white whitespace-nowrap">{row.name}</span>
                      {row.org && <span className="block text-[11px] text-gray-500">{row.org}</span>}
                    </td>
                    {row.picks.map((pick, i) => (
                      <td key={i} className="py-2 px-2 text-center">
                        <HitPill pick={pick} hit={row.hits[i]} />
                      </td>
                    ))}
                    <td className={`py-2 pl-2 text-center text-sm font-bold tabular-nums ${perfect ? 'text-brand' : 'text-gray-200'}`}>
                      {score}/{attempted}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Full-ballot leaderboard */}
      <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5 mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Full-Ballot Leaderboard</h3>
        <p className="text-[11px] text-gray-500 mb-3">Share of predicted categories called correctly.</p>
        <div className="space-y-1.5">
          {retro.leaderboard.map((entry, idx) => {
            const pct = Math.round((entry.correct / entry.attempted) * 100);
            const showGroup = !!entry.group && entry.group !== retro.leaderboard[idx - 1]?.group;
            return (
              <Fragment key={entry.name}>
                {showGroup && (
                  <div className="pt-2.5 pb-0.5">
                    <span className="text-[10px] font-bold text-brand/80 uppercase tracking-[0.14em]">{entry.group}</span>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <div className="w-44 sm:w-56 flex-shrink-0 text-[13px] font-medium text-white truncate">
                    {entry.name}
                    {entry.org && <span className="text-gray-500 font-normal"> · {entry.org}</span>}
                  </div>
                  <div className="flex-1 h-4 rounded bg-white/5 overflow-hidden">
                    <div
                      className={`h-full rounded ${entry.highlight ? 'bg-emerald-500/70' : 'bg-brand/60'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="w-10 text-right text-[13px] font-bold text-white tabular-nums">{pct}%</div>
                  <div className="w-12 text-right text-[11px] text-gray-500 tabular-nums">
                    {entry.correct}/{entry.attempted}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-500 mt-3">{retro.leaderboardNote}</p>
      </div>

      {/* How the markets moved */}
      {retro.marketMoves && (
        <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5 mb-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">{retro.marketMoves.title}</h3>
          <p className="text-[11px] text-gray-500 mb-3">{retro.marketMoves.subtitle}</p>
          <div className="space-y-2">
            {retro.marketMoves.rows.map(m => (
              <div key={m.category} className="flex items-start gap-3 text-[13px]">
                <span
                  className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${m.verdict === 'right' ? 'bg-emerald-400' : 'bg-red-400'}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <span className="font-medium text-white">{m.category.replace('Best ', '')}</span>
                  <span className="text-gray-400">
                    {' '}— {m.from} <span className="text-gray-600">→</span> {m.to}
                  </span>
                  <span className="text-gray-500"> · {m.note}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upsets */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        {retro.upsets.map(upset => (
          <div key={upset.title} className="rounded-xl border border-white/5 bg-surface-overlay p-4">
            <p className="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-1.5">{upset.tag}</p>
            <h4 className="text-sm font-bold text-white mb-1.5">{upset.title}</h4>
            <p className="text-xs text-gray-400 leading-relaxed">{upset.body}</p>
          </div>
        ))}
      </div>

      {/* Beat the Critics summary — branded wordmark + stats (no entry count) */}
      <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <a href="/beat-the-critics" className="text-base font-black tracking-tighter text-white hover:opacity-90 transition-opacity">
          Beat <span className="bg-gradient-to-br from-brand to-[#ff1368] bg-clip-text text-transparent">the Critics</span>
          <sup className="text-[9px] font-bold text-gray-500 align-super ml-0.5">&trade;</sup>
        </a>
        <span className="text-gray-400 text-[13px]">
          players averaged <span className="text-gray-200 font-semibold tabular-nums">{retro.btc.avgScore}/{retro.btc.totalCategories}</span> each
        </span>
        {retro.btc.consensusScore != null && (
          <span className="text-gray-400 text-[13px]">
            their consensus ballot hit <span className="text-gray-200 font-semibold tabular-nums">{retro.btc.consensusScore}/{retro.btc.totalCategories}</span>
          </span>
        )}
        <span className="text-gray-400 text-[13px]">
          <span className="text-emerald-400 font-semibold tabular-nums">{retro.btc.beatAllThreePct}%</span> beat all three critics
        </span>
      </div>

      <p className="text-[11px] text-gray-500 mt-3">{retro.asOf}</p>
    </section>
  );
}
