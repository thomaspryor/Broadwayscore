'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/show-cards/Modal';
import { accessToken } from './CriticClaimPanel';
import { BIO_MAX, TITLE_MAX, MAX_LINKS } from '@/lib/critic-claim';

export interface EditableProfile {
  photoUrl: string | null; jobTitle: string | null; bio: string | null; outlets: string[];
  links: { label: string; url: string }[]; picks: { bestEver?: string; thisSeason?: string }; pinnedReviewKey: string | null;
}

const inputClasses = 'w-full px-3 py-2.5 bg-surface-overlay border border-white/10 rounded-lg text-white placeholder:text-fg-muted focus:ring-2 focus:ring-brand focus:border-transparent';
const btnPrimary = 'px-4 py-2 bg-brand text-gray-900 text-sm font-semibold rounded-lg hover:bg-brand-hover transition-colors disabled:opacity-50';
const label = 'block text-sm font-medium text-gray-200 mb-1';

/** Square-crop and re-encode to a 512px JPEG so uploads stay small and are always JPEG. */
async function toSquareJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 512, 512);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.85));
}

export default function CriticProfileEditor({ open, onClose, slug, profile, notifyOpeningNight, reviewOptions, onSaved }: {
  open: boolean; onClose: () => void; slug: string; profile: EditableProfile | null;
  notifyOpeningNight: boolean; reviewOptions: { key: string; label: string }[]; onSaved: () => void;
}) {
  const [jobTitle, setJobTitle] = useState('');
  const [bio, setBio] = useState('');
  const [outlets, setOutlets] = useState('');
  const [links, setLinks] = useState<{ label: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setJobTitle(profile?.jobTitle || ''); setBio(profile?.bio || '');
    setOutlets((profile?.outlets || []).join(', '));
    setLinks(profile?.links?.length ? profile.links : [{ label: '', url: '' }]);
    setError('');
  }, [open, profile]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const token = await accessToken();
      if (!token) { setError('Please sign in again.'); return; }
      const res = await fetch('/api/critics/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          slug, jobTitle, bio,
          outlets: outlets.split(',').map((o) => o.trim()).filter(Boolean),
          links: links.filter((l) => l.label.trim() && l.url.trim()),
          // Fields this form does not edit are sent back unchanged.
          picks: profile?.picks || {}, pinnedReviewKey: profile?.pinnedReviewKey || null,
          notifyOpeningNight,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || 'Could not save. Please try again.'); return; }
      onSaved();
    } catch { setError('Could not save. Please try again.'); } finally { setBusy(false); }
  }

  async function uploadPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const token = await accessToken();
      if (!token) { setError('Please sign in again.'); return; }
      const fd = new FormData();
      fd.set('slug', slug);
      fd.set('photo', await toSquareJpeg(file), 'photo.jpg');
      const res = await fetch('/api/critics/photo', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || 'Upload failed.'); return; }
      onSaved();
    } catch { setError('Could not read that image. Try a JPEG or PNG.'); } finally { setBusy(false); }
  }

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="lg" ariaLabel="Edit your page">
      <form onSubmit={save} className="p-6 space-y-4 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-bold text-white">Edit your page</h2>
        <div>
          <label htmlFor="ed-photo" className={label}>Photo</label>
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {profile?.photoUrl && <img src={profile.photoUrl} alt="" className="w-14 h-14 rounded-full object-cover" width={56} height={56} />}
            <input id="ed-photo" type="file" accept="image/*" disabled={busy} onChange={(e) => uploadPhoto(e.target.files?.[0])} className="text-sm text-fg-muted" />
          </div>
        </div>
        <div>
          <label htmlFor="ed-title" className={label}>Job title</label>
          <input id="ed-title" maxLength={TITLE_MAX} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className={inputClasses} />
        </div>
        <div>
          <label htmlFor="ed-bio" className={label}>Short bio ({bio.length}/{BIO_MAX})</label>
          <textarea id="ed-bio" rows={4} maxLength={BIO_MAX} value={bio} onChange={(e) => setBio(e.target.value)} className={inputClasses} />
        </div>
        <div>
          <label htmlFor="ed-outlets" className={label}>Outlets you write for (comma separated)</label>
          <input id="ed-outlets" value={outlets} onChange={(e) => setOutlets(e.target.value)} className={inputClasses} />
        </div>
        <div>
          <span className={label}>Links</span>
          <div className="space-y-2">
            {links.map((l, i) => (
              <div key={i} className="flex gap-2">
                <input aria-label="Link label" placeholder="Website" maxLength={40} value={l.label} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={`${inputClasses} w-1/3`} />
                <input aria-label="Link URL" type="url" placeholder="https://" value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} className={inputClasses} />
              </div>
            ))}
            {links.length < MAX_LINKS && (
              <button type="button" onClick={() => setLinks([...links, { label: '', url: '' }])} className="text-sm text-brand hover:underline">Add another link</button>
            )}
          </div>
        </div>
        <p className="text-xs text-fg-muted">Your scores and reviews come from your published work and can&apos;t be edited here.</p>
        {error && <p role="alert" className="text-sm text-score-skip">{error}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-fg-muted hover:text-white">Cancel</button>
        </div>
        <span hidden>{reviewOptions.length}</span>
      </form>
    </Modal>
  );
}
