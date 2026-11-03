'use client';

import { useCallback, useEffect, useState } from 'react';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { getSupabaseClient } from '@/lib/supabase';
import Modal from '@/components/show-cards/Modal';
import { FlagScoreModal, AddReviewModal } from './CriticRequestModals';
import CriticProfileEditor, { type EditableProfile } from './CriticProfileEditor';

// BRO-6895: the "Are you X? Claim this page" prompt and the owner's edit entry.
// Reads nothing about scores; it only moves a request to /api/critics/*.

type Me =
  | { state: 'loading' | 'signed-out' | 'none' | 'pending' | 'unavailable' }
  | { state: 'owner'; profile: EditableProfile | null; notifyOpeningNight: boolean; views30?: number };

export async function accessToken(): Promise<string | null> {
  const client = await getSupabaseClient();
  const { data } = (await client?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

const inputClasses = 'w-full px-3 py-2.5 bg-surface-overlay border border-white/10 rounded-lg text-white placeholder:text-fg-muted focus:ring-2 focus:ring-brand focus:border-transparent';
const btnPrimary = 'px-4 py-2 bg-brand text-gray-900 text-sm font-semibold rounded-lg hover:bg-brand-hover transition-colors disabled:opacity-50';

export default function CriticClaimPanel({ slug, name, outlet, claimed, reviewOptions }: {
  slug: string;
  name: string;
  outlet: string;
  claimed: boolean;
  reviewOptions: { key: string; label: string }[];
}) {
  const { user, loading, isAuthenticated, showSignIn } = useAuth();
  const [me, setMe] = useState<Me>({ state: 'loading' });
  const [claimOpen, setClaimOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const refresh = useCallback(async () => {
    const token = await accessToken();
    if (!token) { setMe({ state: 'signed-out' }); return; }
    try {
      const res = await fetch(`/api/critics/me?slug=${encodeURIComponent(slug)}`, { headers: { Authorization: `Bearer ${token}` } });
      setMe(res.ok ? await res.json() : { state: 'signed-out' });
    } catch { setMe({ state: 'unavailable' }); }
  }, [slug]);

  useEffect(() => {
    if (loading) return;
    if (!isAuthenticated) { setMe({ state: 'signed-out' }); return; }
    refresh();
  }, [loading, isAuthenticated, refresh]);

  if (!featureFlags.userAccounts) return null;

  if (me.state === 'owner') {
    return (
      <>
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-brand/30 bg-brand/10 px-4 py-3 text-sm">
          <span className="text-white">This is your page. Scores and reviews come from your published work and can&apos;t be edited here.</span>
          <button type="button" onClick={() => setEditOpen(true)} className={btnPrimary}>Edit your page</button>
        </div>
        <div className="mb-4 -mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <button type="button" onClick={() => setAddOpen(true)} className="text-brand hover:underline">Add a missing review</button>
          <button type="button" onClick={() => setFlagOpen(true)} className="text-brand hover:underline">Flag a score</button>
        </div>
        <FlagScoreModal open={flagOpen} onClose={() => setFlagOpen(false)} slug={slug} reviewOptions={reviewOptions} />
        <AddReviewModal open={addOpen} onClose={() => setAddOpen(false)} criticName={name} outlet={outlet} />
        <CriticProfileEditor
          open={editOpen} onClose={() => setEditOpen(false)} slug={slug} profile={me.profile}
          notifyOpeningNight={me.notifyOpeningNight} views30={me.views30 ?? 0} reviewOptions={reviewOptions}
          onSaved={() => { setEditOpen(false); refresh(); window.location.reload(); }}
        />
      </>
    );
  }
  if (claimed) return null;
  if (me.state === 'pending') {
    return <div className="mb-4 rounded-lg border border-white/10 bg-surface-raised px-4 py-3 text-sm text-fg-muted">Thanks, we have your request for this page. We&apos;ll be in touch by email.</div>;
  }
  if (me.state === 'unavailable') return null;

  const start = () => {
    if (!isAuthenticated) { showSignIn('generic', 'critic_claim', { returnTo: `/critics/${slug}` }); return; }
    setClaimOpen(true);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-brand/50 bg-brand/10 px-4 py-3 text-sm">
        <span className="text-white"><strong>Are you {name}?</strong> <span className="text-fg-muted">Add a photo, bio and links to this page.</span></span>
        <button type="button" onClick={start} className={btnPrimary}>Claim this page</button>
      </div>
      <ClaimModal open={claimOpen} onClose={() => setClaimOpen(false)} slug={slug} name={name} defaultEmail={user?.email || ''} onDone={() => setMe({ state: 'pending' })} />
    </>
  );
}

function ClaimModal({ open, onClose, slug, name, defaultEmail, onDone }: {
  open: boolean; onClose: () => void; slug: string; name: string; defaultEmail: string; onDone: () => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [workUrl, setWorkUrl] = useState('');
  const [socials, setSocials] = useState<{ platform: string; value: string }[]>([{ platform: 'instagram', value: '' }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { if (defaultEmail) setEmail((e) => e || defaultEmail); }, [defaultEmail]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const token = await accessToken();
      if (!token) { setError('Please sign in again.'); return; }
      const res = await fetch('/api/critics/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug, contactEmail: email, socials, workUrl, note }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || 'Something went wrong. Please try again.'); return; }
      setSent(true); onDone();
    } catch { setError('Something went wrong. Please try again.'); } finally { setBusy(false); }
  }

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="md" ariaLabel={`Claim ${name}'s page`}>
      <div className="p-6">
        {sent ? (
          <>
            <h2 className="text-lg font-bold text-white mb-2">Request sent</h2>
            <p className="text-fg-muted text-sm mb-4">We&apos;ll be in touch by email.</p>
            <button type="button" onClick={onClose} className={btnPrimary}>Close</button>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-lg font-bold text-white">Claim {name}&apos;s page</h2>
            <div>
              <label htmlFor="claim-email" className="block text-sm font-medium text-gray-200 mb-1">Best email to reach you</label>
              <input id="claim-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClasses} />
            </div>
            <fieldset>
              <legend className="block text-sm font-medium text-gray-200 mb-1">Your main social account (at least one)</legend>
              {socials.map((s, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <select aria-label={`Platform ${i + 1}`} value={s.platform} onChange={(e) => setSocials((all) => all.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))} className={inputClasses + ' !w-auto'}>
                    {['instagram', 'x', 'bluesky', 'threads', 'tiktok', 'linkedin', 'facebook'].map((p) => <option key={p} value={p}>{p === 'x' ? 'X' : p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                  </select>
                  <input aria-label={`Social link ${i + 1}`} id={`claim-social-${i}`} type="text" required={i === 0} value={s.value} onChange={(e) => setSocials((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="@handle or link" className={inputClasses} />
                </div>
              ))}
              {socials.length < 3 && (
                <button type="button" onClick={() => setSocials((all) => [...all, { platform: 'x', value: '' }])} className="text-sm text-brand hover:underline">Add another account</button>
              )}
              <p className="text-xs text-fg-muted mt-1">We&apos;ll message you there or by email to confirm it&apos;s you.</p>
            </fieldset>
            <div>
              <label htmlFor="claim-url" className="block text-sm font-medium text-gray-200 mb-1">Where can we see your work? (optional)</label>
              <input id="claim-url" type="url" value={workUrl} onChange={(e) => setWorkUrl(e.target.value)} placeholder="Outlet author page or website" className={inputClasses} />
            </div>
            <div>
              <label htmlFor="claim-note" className="block text-sm font-medium text-gray-200 mb-1">Anything else (optional)</label>
              <textarea id="claim-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputClasses} />
            </div>
            {error && <p role="alert" className="text-sm text-score-skip">{error}</p>}
            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Sending…' : 'Send request'}</button>
              <span className="text-xs text-fg-muted">We&apos;ll be in touch by email.</span>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
