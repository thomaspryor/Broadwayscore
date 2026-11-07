'use client';

import { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import type { LeaderboardEntry } from '@/config/fantasy';

type LeagueMeta = { code: string; name: string; created_at: string | null; member_count: number };

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function CopyLinkButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== 'undefined'
    ? `${window.location.origin}/fantasy/league/${encodeURIComponent(code)}`
    : `/fantasy/league/${encodeURIComponent(code)}`;

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

export default function LeaguePage(props: { params: Promise<{ code: string }> }) {
  const params = use(props.params);
  // Free-text league names can contain spaces; decode once so API calls and
  // links re-encode the plain name.
  const code = safeDecode(params.code);
  const [meta, setMeta] = useState<LeagueMeta | null>(null);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  // Draft still open: the API sends team names only, no picks or points.
  const [hidden, setHidden] = useState<{ teams: string[]; revealsOn: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, lbRes] = await Promise.all([
        fetch(`/api/fantasy/leagues/${encodeURIComponent(code)}`),
        fetch(`/api/fantasy/leaderboard?league=${encodeURIComponent(code)}`),
      ]);
      if (!metaRes.ok) {
        setError(metaRes.status === 404 ? 'League not found.' : 'Failed to load league.');
        return;
      }
      const [metaData, lbData] = await Promise.all([metaRes.json(), lbRes.json()]);
      // The standings API answers 200 with { entries: [], error } when the
      // database fails; that must not read as an empty league (BRO-5548).
      if (lbData.error) {
        setError('Could not load the league standings. Please try again.');
        return;
      }
      setMeta(metaData);
      setEntries(lbData.entries || []);
      setHidden(lbData.meta?.picksHidden ? { teams: lbData.teams || [], revealsOn: lbData.meta.revealsOn } : null);
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
        {error !== 'League not found.' && (
          <button type="button" onClick={() => load()} className="block mx-auto mb-4 px-6 py-2.5 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors">
            Try again
          </button>
        )}
        <Link href="/fantasy" className="text-brand hover:underline">← Back to Fantasy League</Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <Link href="/fantasy" className="text-sm text-fg-muted hover:text-gray-300 transition-colors">
          ← Fantasy League
        </Link>

        <div className="mt-4 mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">{meta?.name}</h1>
          <p className="text-fg-muted text-sm mt-1">{meta?.member_count ?? 0} member{meta?.member_count !== 1 ? 's' : ''}</p>
        </div>

        <div className="flex flex-wrap gap-3 mb-8">
          <CopyLinkButton code={code} />
          <Link
            href={`/fantasy/draft?league=${encodeURIComponent(code)}`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-raised border border-white/10 text-sm font-semibold hover:bg-surface-overlay transition-all"
          >
            Draft your team →
          </Link>
        </div>

        {hidden && hidden.teams.length > 0 ? (
          <div className="space-y-2">
            <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-1">Teams drafted</h2>
            <p className="text-gray-400 text-base mb-3">
              Picks and standings stay hidden until the draft closes on {new Date(`${hidden.revealsOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}.
            </p>
            {hidden.teams.map((name, i) => (
              <div key={`${name}-${i}`} className="card p-4 font-semibold text-white truncate">{name}</div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-gray-400 mb-2">No entries yet.</p>
            <p className="text-fg-muted text-sm">Share the invite link so friends can draft their teams.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <h2 className="text-sm text-fg-muted uppercase tracking-wider mb-3">Leaderboard</h2>
            {entries.map((entry) => (
              <div key={entry.id} className="card p-4 flex items-center gap-4">
                <div className="w-8 text-center font-bold text-fg-muted text-sm">#{entry.rank}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-white truncate">
                    {entry.displayName}
                  </div>
                  <div className="text-sm text-gray-400">
                    {entry.picks.length} {entry.picks.length === 1 ? 'show' : 'shows'} &middot; ${entry.picks.reduce((sum, p) => sum + p.price, 0)} spent
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-brand">{entry.totalPoints.toFixed(1)}</div>
                  <div className="text-xs text-fg-muted">pts</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
