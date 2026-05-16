import { notFound } from 'next/navigation';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GapsByBucket {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
}

interface GapsBySource {
  [source: string]: number;
}

interface HistorySnapshot {
  date: string;
  timestamp: string;
  totalCritics: number;
  totalGaps: number;
  gapsByBucket: GapsByBucket;
  gapsBySource: GapsBySource;
  perCritic?: Record<string, number>;
}

interface TopCritic {
  name: string;
  outlet: string;
  tier: number;
  missingCount: number;
  lastDate: string;
}

interface CriticCoveragePayload {
  generatedAt: string;
  current: {
    totalCritics: number;
    totalGaps: number;
    gapsByBucket: GapsByBucket;
    gapsBySource: GapsBySource;
  };
  history: HistorySnapshot[];
  topCriticsByGap: TopCritic[];
}

// ---------------------------------------------------------------------------
// Bucket labels (from scripts/audit-critic-coverage-bucket.js)
// ---------------------------------------------------------------------------

const BUCKET_LABELS: Record<keyof GapsByBucket, { short: string; description: string }> = {
  A: { short: 'Exact URL misattribution', description: 'We have the review but under the wrong critic name' },
  B: { short: 'Show+outlet misattribution', description: 'A different review of the same show in the same outlet' },
  C: { short: 'Not Broadway', description: 'Off-Broadway, regional, books, or other non-qualifying content' },
  D: { short: 'True missing Broadway', description: 'Genuine gap — no Broadway review from this critic in our data' },
  E: { short: 'True missing West End', description: 'Genuine gap — no West End review from this critic in our data' },
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function readDigest(): CriticCoveragePayload | null {
  const filePath = path.join(process.cwd(), 'public', 'data', 'admin', 'critic-coverage.json');
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as CriticCoveragePayload;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delta(current: number, prior: number | undefined): { sign: string; diff: number } {
  if (prior === undefined) return { sign: '▬', diff: 0 };
  const diff = current - prior;
  if (diff > 0) return { sign: '▲', diff };
  if (diff < 0) return { sign: '▼', diff };
  return { sign: '▬', diff: 0 };
}

function deltaClass(sign: string): string {
  if (sign === '▲') return 'text-score-skip'; // gaps increased = bad
  if (sign === '▼') return 'text-status-open'; // gaps decreased = good
  return 'text-gray-500';
}

function tierLabel(tier: number): string {
  if (tier === 1) return 'T1';
  if (tier === 2) return 'T2';
  return 'T3';
}

function tierClass(tier: number): string {
  if (tier === 1) return 'text-amber-400';
  if (tier === 2) return 'text-sky-400';
  return 'text-gray-400';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminCriticCoveragePage() {
  if (!isAdmin()) {
    notFound();
  }

  const digest = readDigest();
  if (!digest) {
    notFound();
  }

  const { current, history, topCriticsByGap, generatedAt } = digest;

  // Prior snapshot for WoW comparison (second-to-last, or first if only one)
  const priorSnapshot: HistorySnapshot | undefined =
    history.length >= 2 ? history[history.length - 2] : undefined;
  const latestSnapshot: HistorySnapshot | undefined =
    history.length >= 1 ? history[history.length - 1] : undefined;

  // Newly missing this week: critics whose missingCount went UP vs prior snapshot
  const newlyMissing: Array<{ name: string; prev: number; curr: number }> = [];
  if (priorSnapshot?.perCritic && latestSnapshot?.perCritic) {
    for (const [name, curr] of Object.entries(latestSnapshot.perCritic)) {
      const prev = priorSnapshot.perCritic[name] ?? 0;
      if (curr > prev) {
        newlyMissing.push({ name, prev, curr });
      }
    }
    newlyMissing.sort((a, b) => b.curr - b.prev - (a.curr - a.prev));
  }

  // Total-gaps trend: oldest-first, up to 12
  const trendRows = history.slice(-12);

  const totalDelta = delta(current.totalGaps, priorSnapshot?.totalGaps);

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">

        {/* Header */}
        <header className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Critic Coverage</h1>
          <p className="text-sm text-gray-400 mt-1">
            Gap audit across tracked critics — how many shows are we missing from each?
          </p>
          <p className="text-[11px] text-gray-500 mt-1">
            Digest generated{' '}
            <time dateTime={generatedAt}>{new Date(generatedAt).toLocaleString()}</time>
            {' · '}
            {current.totalCritics} critics tracked
            {' · '}
            <span className="text-white font-semibold">{current.totalGaps.toLocaleString()}</span> total gaps
            {' '}
            <span className={`${deltaClass(totalDelta.sign)} font-medium`}>
              {totalDelta.sign}{totalDelta.diff !== 0 ? Math.abs(totalDelta.diff) : ''}
            </span>
            {' vs prior snapshot'}
          </p>
        </header>

        {/* Bucket Breakdown */}
        <section className="mb-8">
          <h2 className="text-base font-semibold text-white mb-3">Gap breakdown by bucket</h2>
          <div className="bg-surface-raised rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">Bucket</th>
                  <th className="px-4 py-3 text-left">Label</th>
                  <th className="px-4 py-3 text-left hidden sm:table-cell">Description</th>
                  <th className="px-4 py-3 text-right">Count</th>
                  <th className="px-4 py-3 text-right">WoW</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(BUCKET_LABELS) as Array<keyof GapsByBucket>).map((bucket, i) => {
                  const count = current.gapsByBucket[bucket] ?? 0;
                  const priorCount = priorSnapshot?.gapsByBucket[bucket];
                  const d = delta(count, priorCount);
                  return (
                    <tr
                      key={bucket}
                      className={`border-b border-white/5 last:border-0 ${i % 2 === 0 ? '' : 'bg-surface-overlay/30'}`}
                    >
                      <td className="px-4 py-3 font-mono font-bold text-white">{bucket}</td>
                      <td className="px-4 py-3 text-gray-300">{BUCKET_LABELS[bucket].short}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">
                        {BUCKET_LABELS[bucket].description}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-white">
                        {count.toLocaleString()}
                      </td>
                      <td className={`px-4 py-3 text-right font-medium ${deltaClass(d.sign)}`}>
                        {d.sign}{d.diff !== 0 ? Math.abs(d.diff) : ''}
                      </td>
                    </tr>
                  );
                })}
                {/* Totals row */}
                <tr className="border-t border-white/20 bg-surface-overlay/50 font-semibold">
                  <td className="px-4 py-3 text-gray-400">—</td>
                  <td className="px-4 py-3 text-white">Total</td>
                  <td className="px-4 py-3 hidden sm:table-cell" />
                  <td className="px-4 py-3 text-right text-white">{current.totalGaps.toLocaleString()}</td>
                  <td className={`px-4 py-3 text-right ${deltaClass(totalDelta.sign)}`}>
                    {totalDelta.sign}{totalDelta.diff !== 0 ? Math.abs(totalDelta.diff) : ''}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Top 10 Critics by Gap */}
        <section className="mb-8">
          <h2 className="text-base font-semibold text-white mb-3">Top critics by gap count</h2>
          <div className="bg-surface-raised rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">#</th>
                  <th className="px-4 py-3 text-left">Critic</th>
                  <th className="px-4 py-3 text-left hidden sm:table-cell">Outlet</th>
                  <th className="px-4 py-3 text-center">Tier</th>
                  <th className="px-4 py-3 text-right">Missing</th>
                  <th className="px-4 py-3 text-right hidden md:table-cell">Last review</th>
                </tr>
              </thead>
              <tbody>
                {topCriticsByGap.map((critic, i) => (
                  <tr
                    key={critic.name}
                    className={`border-b border-white/5 last:border-0 ${i % 2 === 0 ? '' : 'bg-surface-overlay/30'}`}
                  >
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">{i + 1}</td>
                    <td className="px-4 py-3 text-white font-medium">{critic.name}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden sm:table-cell">
                      {critic.outlet}
                    </td>
                    <td className={`px-4 py-3 text-center font-semibold text-xs ${tierClass(critic.tier)}`}>
                      {tierLabel(critic.tier)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-white">
                      {critic.missingCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs hidden md:table-cell">
                      {critic.lastDate}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Total Gaps Trend (text table, no chart lib) */}
        {trendRows.length > 0 && (
          <section className="mb-8">
            <h2 className="text-base font-semibold text-white mb-3">Total gaps trend</h2>
            <div className="bg-surface-raised rounded-xl border border-white/10 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-right">Critics</th>
                    <th className="px-4 py-3 text-right">Total gaps</th>
                    <th className="px-4 py-3 text-right">A</th>
                    <th className="px-4 py-3 text-right">B</th>
                    <th className="px-4 py-3 text-right">C</th>
                    <th className="px-4 py-3 text-right">D</th>
                    <th className="px-4 py-3 text-right">E</th>
                    <th className="px-4 py-3 text-right">WoW</th>
                  </tr>
                </thead>
                <tbody>
                  {trendRows.map((row, i) => {
                    const prevTotal = i > 0 ? trendRows[i - 1].totalGaps : undefined;
                    const d = delta(row.totalGaps, prevTotal);
                    return (
                      <tr
                        key={row.timestamp}
                        className={`border-b border-white/5 last:border-0 ${i % 2 === 0 ? '' : 'bg-surface-overlay/30'}`}
                      >
                        <td className="px-4 py-3 text-gray-300 font-mono text-xs">{row.date}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.totalCritics}</td>
                        <td className="px-4 py-3 text-right font-semibold text-white">
                          {row.totalGaps.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.gapsByBucket.A}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.gapsByBucket.B}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.gapsByBucket.C}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.gapsByBucket.D}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.gapsByBucket.E}</td>
                        <td className={`px-4 py-3 text-right font-medium ${deltaClass(d.sign)}`}>
                          {i === 0 ? '—' : `${d.sign}${d.diff !== 0 ? Math.abs(d.diff) : ''}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-600 mt-2">
              A = Exact URL misattribution · B = Show+outlet misattribution · C = Not Broadway/WE · D = True missing Broadway · E = True missing West End
            </p>
          </section>
        )}

        {/* Newly Missing This Week */}
        {newlyMissing.length > 0 && (
          <section className="mb-8">
            <h2 className="text-base font-semibold text-white mb-1">
              Newly missing this week
              <span className="ml-2 text-xs font-normal text-score-tepid">
                {newlyMissing.length} critic{newlyMissing.length !== 1 ? 's' : ''} with increased gap vs prior snapshot
              </span>
            </h2>
            <div className="bg-surface-raised rounded-xl border border-white/10 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left">Critic</th>
                    <th className="px-4 py-3 text-right">Prior</th>
                    <th className="px-4 py-3 text-right">Current</th>
                    <th className="px-4 py-3 text-right">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {newlyMissing.map((row, i) => {
                    const added = row.curr - row.prev;
                    return (
                      <tr
                        key={row.name}
                        className={`border-b border-white/5 last:border-0 ${i % 2 === 0 ? '' : 'bg-surface-overlay/30'}`}
                      >
                        <td className="px-4 py-3 text-white font-medium">{row.name}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{row.prev}</td>
                        <td className="px-4 py-3 text-right text-white font-semibold">{row.curr}</td>
                        <td className="px-4 py-3 text-right text-score-skip font-semibold">
                          ▲{added}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* No newly-missing state */}
        {newlyMissing.length === 0 && priorSnapshot && (
          <section className="mb-8">
            <div className="bg-surface-raised rounded-xl border border-white/10 px-6 py-4 text-sm text-gray-400">
              <span className="text-status-open mr-2">✓</span>
              No critics with an increased gap count vs the prior snapshot.
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
