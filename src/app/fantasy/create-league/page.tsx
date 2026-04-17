'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CreateLeaguePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/fantasy/leagues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), created_by_email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Something went wrong'); return; }
      router.push(`/fantasy/league/${data.code}`);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-md mx-auto px-4 py-16">
        <a href="/fantasy" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          ← Fantasy League
        </a>
        <h1 className="text-2xl font-bold mt-4 mb-2">Create a Private League</h1>
        <p className="text-gray-400 text-sm mb-8">
          Get a shareable link to invite friends into your own league leaderboard.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">League Name *</label>
            <input
              type="text"
              className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
              placeholder="e.g. Theater Nerds 2026"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={60}
              required
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Your Email *</label>
            <input
              type="email"
              className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
              placeholder="you@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <p className="text-xs text-gray-600 mt-1">Used to identify you as the creator. Not shared publicly.</p>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !name.trim() || !email.includes('@')}
            className="w-full py-3 rounded-lg font-semibold bg-brand text-[#09090b] hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {loading ? 'Creating...' : 'Create League →'}
          </button>
        </form>
      </div>
    </div>
  );
}
