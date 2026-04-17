'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

type LeagueMeta = { code: string; name: string; created_at: string; member_count: number };
type LeaderboardEntry = {
  rank: number;
  team_name: string | null;
  email: string;
  total_cost: number;
  total_points: number;
};

function CopyLinkButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== 'undefined'
    ? `${window.location.origin}/fantasy/league/${code}`
    : `/fantasy/league/${code}`;

  function handleCopy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-[#09090b] text-sm font-semibold hover:bg-brand-hover transition-all"
    >
      {copied ? '✓ Copied!' : '📋 Copy invite link'}
    </button>
  );
}

export default function LeaguePage({ params }: { params: { code: string } }) {
  const { code } = params;
  const [meta, setMeta] = useState<LeagueMeta | null>(null);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, lbRes] = await Promise.all([
        fetch(`/api/fantasy/leagues/${code}`),
        fetch(`/api/fantasy/leaderboard?league=${code}`),
      ]);
      if (!metaRes.ok) {
        setError(metaRes.status === 404 ? 'League not found.' : 'Failed to load league.');
        return;
      }
      const [metaData, lbData] = await Promise.all([metaRes.json(), lbRes.json()]);
      setMeta(metaData);
      setEntries(lbData.entries || []);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="min-h-screen bg-surface text-white flex items-center justify-center">
      <div className="text-gray-400">Loading league...</div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-surface text-white flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-400 mb-4">{error}</p>
        <Link href="/fantasy" className="text-brand hover:underline">← Back to Fantasy League</Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <Link href="/fantasy" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          ← Fantasy League
        </Link>

        <div className="mt-4 mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">{meta?.name}</h1>
          <p className="text-gray-500 text-sm mt-1">{meta?.member_count ?? 0} member{meta?.member_count !== 1 ? 's' : ''}</p>
        </div>

        <div className="flex flex-wrap gap-3 mb-8">
          <CopyLinkButton code={code} />
          <Link
            href={`/fantasy/draft?league=${code}`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-raised border border-white/10 text-sm font-semibold hover:bg-surface-overlay transition-all"
          >
            Draft your team →
          </Link>
        </div>

        {entries.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-gray-400 mb-2">No entries yet.</p>
            <p className="text-gray-600 text-sm">Share the invite link so friends can draft their teams.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <h2 className="text-sm text-gray-500 uppercase tracking-wider mb-3">Leaderboard</h2>
            {entries.map((entry) => (
              <div key={entry.email} className="card p-4 flex items-center gap-4">
                <div className="w-8 text-center font-bold text-gray-500 text-sm">#{entry.rank}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-white truncate">
                    {entry.team_name || entry.email}
                  </div>
                  <div className="text-xs text-gray-500">${entry.total_cost} spent</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-brand">{entry.total_points.toFixed(1)}</div>
                  <div className="text-xs text-gray-600">pts</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
