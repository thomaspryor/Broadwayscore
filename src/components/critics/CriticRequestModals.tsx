'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/show-cards/Modal';
import { accessToken } from './CriticClaimPanel';
import { FLAG_NOTE_MAX } from '@/lib/critic-claim';

const inputClasses = 'w-full px-3 py-2.5 bg-surface-overlay border border-white/10 rounded-lg text-white placeholder:text-fg-muted focus:ring-2 focus:ring-brand focus:border-transparent';
const btnPrimary = 'px-4 py-2 bg-brand text-gray-900 text-sm font-semibold rounded-lg hover:bg-brand-hover transition-colors disabled:opacity-50';
const label = 'block text-sm font-medium text-gray-200 mb-1';

/** "Flag a score": a message to us about one of your own reviews. It never changes a score. */
export function FlagScoreModal({ open, onClose, slug, reviewOptions }: {
  open: boolean; onClose: () => void; slug: string; reviewOptions: { key: string; label: string }[];
}) {
  const [reviewKey, setReviewKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setReviewKey(''); setNote(''); setDone(false); setError(''); } }, [open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const token = await accessToken();
      if (!token) { setError('Please sign in again.'); return; }
      const res = await fetch('/api/critics/flag', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug, reviewKey, note }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || 'Could not send that. Please try again.'); return; }
      setDone(true);
    } catch { setError('Could not send that. Please try again.'); } finally { setBusy(false); }
  }

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="md" ariaLabel="Flag a score">
      {done ? (
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Thanks, we have it</h2>
          <p className="text-sm text-fg-muted">We&apos;ll take a look and be in touch by email.</p>
          <button type="button" onClick={onClose} className={btnPrimary}>Close</button>
        </div>
      ) : (
        <form onSubmit={send} className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Flag a score</h2>
          <div>
            <label htmlFor="fl-review" className={label}>Which review?</label>
            <select id="fl-review" required value={reviewKey} onChange={(e) => setReviewKey(e.target.value)} className={inputClasses}>
              <option value="">Choose one of your reviews</option>
              {reviewOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="fl-note" className={label}>What looks wrong? ({note.length}/{FLAG_NOTE_MAX})</label>
            <textarea id="fl-note" required rows={4} maxLength={FLAG_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} className={inputClasses} />
          </div>
          <p className="text-xs text-fg-muted">This sends us a message. Scores are set from your published review, so nothing changes until we have looked.</p>
          {error && <p role="alert" className="text-sm text-score-skip">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Sending…' : 'Send'}</button>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-fg-muted hover:text-white">Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** "Add a missing review": feeds the same submission queue as the public form. */
export function AddReviewModal({ open, onClose, criticName, outlet }: {
  open: boolean; onClose: () => void; criticName: string; outlet: string;
}) {
  const [url, setUrl] = useState('');
  const [show, setShow] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setUrl(''); setShow(''); setDone(false); setError(''); } }, [open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.set('review_url', url); fd.set('show_name', show); fd.set('outlet_name', outlet); fd.set('critic_name', criticName);
      fd.set('notes', 'Submitted by the critic from their claimed page.');
      const res = await fetch('/api/submit-review', { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.errors?.[0]?.message || 'Could not send that. Please try again.'); return; }
      setDone(true);
    } catch { setError('Could not send that. Please try again.'); } finally { setBusy(false); }
  }

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="md" ariaLabel="Add a missing review">
      {done ? (
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Thanks, we have it</h2>
          <p className="text-sm text-fg-muted">We&apos;ll add it once we have checked the link.</p>
          <button type="button" onClick={onClose} className={btnPrimary}>Close</button>
        </div>
      ) : (
        <form onSubmit={send} className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Add a missing review</h2>
          <div>
            <label htmlFor="ar-url" className={label}>Link to the review</label>
            <input id="ar-url" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className={inputClasses} />
          </div>
          <div>
            <label htmlFor="ar-show" className={label}>Show (optional)</label>
            <input id="ar-show" value={show} onChange={(e) => setShow(e.target.value)} className={inputClasses} />
          </div>
          {error && <p role="alert" className="text-sm text-score-skip">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Sending…' : 'Send'}</button>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-fg-muted hover:text-white">Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
