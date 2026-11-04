'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/show-cards/Modal';
import { accessToken } from './CriticClaimPanel';
import { FLAG_NOTE_MAX, FLAG_REASONS, type FlagReason } from '@/lib/critic-claim';

const inputClasses = 'w-full px-3 py-2.5 bg-surface-overlay border border-white/10 rounded-lg text-white placeholder:text-fg-muted focus:ring-2 focus:ring-brand focus:border-transparent';
const btnPrimary = 'px-4 py-2 bg-brand text-gray-900 text-sm font-semibold rounded-lg hover:bg-brand-hover transition-colors disabled:opacity-50';
const label = 'block text-sm font-medium text-gray-200 mb-1';

async function postCorrection(payload: Record<string, unknown>): Promise<string | null> {
  try {
    const token = await accessToken();
    if (!token) return 'Please sign in again.';
    const res = await fetch('/api/critics/flag', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    return res.ok ? null : (j.error || 'Could not send that. Please try again.');
  } catch { return 'Could not send that. Please try again.'; }
}

function Sent({ line, onClose }: { line: string; onClose: () => void }) {
  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-bold text-white">Thanks, we have it</h2>
      <p className="text-sm text-fg-muted">{line}</p>
      <button type="button" onClick={onClose} className={btnPrimary}>Close</button>
    </div>
  );
}

/**
 * "Flag a problem" (BRO-6984): a message to us about one of your own reviews.
 * Opened from a review (reviewKey preset) or from the owner bar (pick one).
 * It never changes a score or a review.
 */
export function FlagProblemModal({ open, onClose, slug, reviewOptions, initialReviewKey }: {
  open: boolean; onClose: () => void; slug: string; reviewOptions: { key: string; label: string }[]; initialReviewKey?: string | null;
}) {
  const [reviewKey, setReviewKey] = useState('');
  const [reason, setReason] = useState<FlagReason>('wrong_score');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setReviewKey(initialReviewKey || ''); setReason('wrong_score'); setNote(''); setDone(false); setError(''); } }, [open, initialReviewKey]);
  const preset = initialReviewKey ? reviewOptions.find((o) => o.key === initialReviewKey) : undefined;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const err = await postCorrection({ slug, reviewKey, reason, note });
    setBusy(false);
    if (err) setError(err); else setDone(true);
  }

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="md" ariaLabel="Flag a problem">
      {done ? <Sent line="We'll take a look and be in touch by email." onClose={onClose} /> : (
        <form onSubmit={send} className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Flag a problem</h2>
          {preset ? (
            <p className="text-sm text-gray-300">{preset.label}</p>
          ) : (
            <div>
              <label htmlFor="fl-review" className={label}>Which review?</label>
              <select id="fl-review" required value={reviewKey} onChange={(e) => setReviewKey(e.target.value)} className={inputClasses}>
                <option value="">Choose one of your reviews</option>
                {reviewOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
          )}
          <fieldset>
            <legend className={label}>What&apos;s wrong?</legend>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(FLAG_REASONS) as FlagReason[]).map((r) => (
                <label key={r} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${reason === r ? 'border-brand bg-brand/10 text-white' : 'border-white/10 bg-surface-overlay text-gray-300'}`}>
                  <input type="radio" name="fl-reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="accent-brand" />
                  {FLAG_REASONS[r]}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="fl-note" className={label}>{reason === 'other' ? 'Tell us what' : 'Anything we should know? (optional)'} ({note.length}/{FLAG_NOTE_MAX})</label>
            <textarea id="fl-note" required={reason === 'other'} rows={3} maxLength={FLAG_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} className={inputClasses} />
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

/**
 * "Missing a review? Tell us" (BRO-6984): stored and sent to the owner, then
 * also dropped into the public submission queue (as the older "Add a missing
 * review" did) so the usual ingest can pick it up.
 */
export function MissingReviewModal({ open, onClose, slug, criticName, outlet }: {
  open: boolean; onClose: () => void; slug: string; criticName: string; outlet: string;
}) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setUrl(''); setNote(''); setDone(false); setError(''); } }, [open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const err = await postCorrection({ kind: 'missing', slug, reviewUrl: url, note });
    if (err) { setBusy(false); setError(err); return; }
    try {
      const fd = new FormData();
      fd.set('review_url', url); fd.set('show_name', ''); fd.set('outlet_name', outlet); fd.set('critic_name', criticName);
      fd.set('notes', 'Submitted by the critic from their claimed page.');
      await fetch('/api/submit-review', { method: 'POST', body: fd });
    } catch { /* the owner already has it */ }
    setBusy(false); setDone(true);
  }

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="md" ariaLabel="Missing a review">
      {done ? <Sent line="We'll add it once we have checked the link." onClose={onClose} /> : (
        <form onSubmit={send} className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Missing a review? Tell us</h2>
          <div>
            <label htmlFor="ar-url" className={label}>Link to the review</label>
            <input id="ar-url" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className={inputClasses} />
          </div>
          <div>
            <label htmlFor="ar-note" className={label}>Anything we should know? (optional)</label>
            <textarea id="ar-note" rows={2} maxLength={FLAG_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} className={inputClasses} />
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
