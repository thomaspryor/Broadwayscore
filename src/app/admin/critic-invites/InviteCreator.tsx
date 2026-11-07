'use client';

import { useMemo, useState } from 'react';

// BRO-7087: pick a critic, make an invite link, copy it. The link is signed
// on the server (api/admin/critic-invite); nothing here is trusted.

export interface InviteCritic { slug: string; name: string; outlet: string; reviews: number; owned: boolean }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const btnPrimary = 'px-4 py-2 bg-brand text-gray-900 text-sm font-semibold rounded-lg hover:bg-brand-hover transition-colors disabled:opacity-50';

export default function InviteCreator({ critics }: { critics: InviteCritic[] }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<InviteCritic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ url: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (q.length < 2) return [];
    return critics.filter((c) => fold(c.name).includes(q)).slice(0, 12);
  }, [critics, query]);

  function pick(c: InviteCritic) {
    setPicked(c); setLink(null); setError(''); setCopied(false); setQuery('');
  }

  async function create() {
    if (!picked) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const res = await fetch('/api/admin/critic-invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: picked.slug }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.url) { setError(j.error || 'Could not make the link. Try again.'); return; }
      setLink({ url: j.url, name: j.name || picked.name });
    } catch { setError('Could not make the link. Try again.'); } finally { setBusy(false); }
  }

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4 sm:p-5">
        <label htmlFor="invite-search" className="block text-sm font-medium text-gray-200 mb-1">Find a critic</label>
        <input
          id="invite-search" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a name, e.g. Jesse Green"
          className="w-full px-3 py-2.5 bg-surface-overlay border border-white/10 rounded-lg text-white placeholder:text-fg-muted focus:ring-2 focus:ring-brand focus:border-transparent"
        />
        {matches.length > 0 && (
          <ul className="mt-2 divide-y divide-white/10 rounded-lg border border-white/10 bg-surface-overlay">
            {matches.map((c) => (
              <li key={c.slug}>
                <button type="button" onClick={() => pick(c)} className="w-full text-left px-3 py-2.5 hover:bg-white/5 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block font-medium text-white truncate">{c.name}</span>
                    <span className="block text-xs text-fg-muted truncate">{c.outlet} · {c.reviews} review{c.reviews === 1 ? '' : 's'}</span>
                  </span>
                  {c.owned && <span className="shrink-0 text-xs text-fg-muted">Has an owner</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 && matches.length === 0 && <p className="mt-2 text-sm text-fg-muted">No critic by that name.</p>}
      </div>

      {picked && (
        <div className="card p-4 sm:p-5">
          <p className="text-lg font-bold text-white">{picked.name}</p>
          <p className="text-sm text-fg-muted">{picked.outlet} · {picked.reviews} review{picked.reviews === 1 ? '' : 's'} · <a href={`/critics/${picked.slug}`} target="_blank" rel="noreferrer" className="text-brand hover:underline">See page</a></p>
          {picked.owned ? (
            <p className="mt-3 text-sm text-gray-200">This page already has an owner, so there is no link to send.</p>
          ) : link ? (
            <div className="mt-4">
              <div className="flex flex-col sm:flex-row gap-2">
                <input readOnly aria-label="Invite link" value={link.url} onFocus={(e) => e.currentTarget.select()}
                  className="w-full min-w-0 px-3 py-2.5 bg-surface-overlay border border-white/10 rounded-lg text-white text-sm font-mono" />
                <button type="button" onClick={copy} className={btnPrimary + ' shrink-0'}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <p className="mt-3 text-sm text-gray-200">
                Send this to {link.name}. When they open it and sign in, the page is theirs. Works once, for 14 days.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              <button type="button" onClick={create} disabled={busy} className={btnPrimary}>{busy ? 'Making link…' : 'Create invite link'}</button>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-score-skip">{error}</p>}
        </div>
      )}
    </div>
  );
}
