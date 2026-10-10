'use client';

import { useEffect, useState } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import { usePlanShare } from '@/hooks/usePlanShare';
import { shareOrCopy } from '@/lib/share-link';
import { trackSharedPlans } from '@/lib/shared-plans/events';
import { defaultShareName, validateShareName } from '@/lib/shared-plans/share-url';
import { plansTitle } from '@/lib/shared-plans/view-model';
import ShareLinkPanel from './ShareLinkPanel';

/**
 * Owner sheet for Shared Plans (BRO-4481, docs/specs/shared-plans.md §2.1):
 * choose sections, set the name friends see, share via the native sheet or
 * copy, preview, reset or stop. `counts` come from selectSharedPlans so they
 * match what friends will see.
 */
interface Props {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  profileName: string | null;
  counts: { booked: number; unbooked: number };
  mock?: boolean;
  showToast?: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export default function SharePlansModal({ isOpen, onClose, userId, profileName, counts, mock, showToast }: Props) {
  const { share, url, loading, error, ensure, update, rotate } = usePlanShare(isOpen ? userId : null, { mock });
  const [showBooked, setShowBooked] = useState(true);
  const [showUnbooked, setShowUnbooked] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // Seed the form from the saved share, or from the profile for a first share.
  useEffect(() => {
    if (share) {
      setShowBooked(share.show_booked);
      setShowUnbooked(share.show_unbooked);
      setName(share.display_name);
    } else {
      setName(n => n || defaultShareName(profileName));
    }
  }, [share, profileName]);

  const nameError = validateShareName(name);
  const live = !!share?.enabled;
  const canShare = !busy && !loading && !nameError && (showBooked || showUnbooked);

  // On an existing share, toggles save as soon as they change. A live share
  // with both sections off would 404 for friends while this sheet still says
  // "Sharing is on", so the last section can't be switched off here.
  const setSection = async (which: 'booked' | 'unbooked', on: boolean) => {
    const other = which === 'booked' ? showUnbooked : showBooked;
    if (live && !on && !other) {
      showToast?.('Keep one section on, or use Stop sharing.', 'info');
      return;
    }
    if (which === 'booked') setShowBooked(on); else setShowUnbooked(on);
    if (share) {
      const ok = await update(which === 'booked' ? { show_booked: on } : { show_unbooked: on });
      if (!ok) showToast?.('Couldn’t save that change.', 'error');
    }
  };

  const saveName = async () => {
    if (!share || nameError || name.trim() === share.display_name) return;
    if (!(await update({ display_name: name.trim() }))) showToast?.('Couldn’t save your name.', 'error');
  };

  const handleShare = async () => {
    if (!canShare) return;
    setBusy(true);
    try {
      const created = !live;
      const link = live && share?.display_name === name.trim() ? url : await ensure({ displayName: name, showBooked, showUnbooked });
      if (!link) { showToast?.('Couldn’t create your link. Try again.', 'error'); return; }
      if (!live) trackSharedPlans({ name: 'plans_share_enabled', props: { booked: showBooked, unbooked: showUnbooked } });
      const outcome = await shareOrCopy({ title: 'My theater plans', url: link });
      if (outcome === 'shared') trackSharedPlans({ name: 'plans_shared', props: { method: 'native-sheet' } });
      if (outcome === 'copied') {
        trackSharedPlans({ name: 'plans_shared', props: { method: 'copy' } });
        showToast?.('Link copied!', 'success');
      }
      // Not the URL itself: toasts are page text, and session replay records
      // page text on /my-shows. Preview (excluded from replay) holds the link.
      if (outcome === 'failed') {
        // iOS drops the share sheet when the tap waited on creating the link;
        // the link exists now, so a second tap goes straight to the sheet.
        showToast?.(created ? 'Your link is ready. Tap Share link again to send it.' : 'Couldn’t copy the link. Open Preview and copy it from the address bar.', 'info');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    const ok = await update({ enabled: false });
    setBusy(false);
    if (ok) {
      trackSharedPlans({ name: 'plans_share_stopped', props: {} });
      showToast?.('Sharing stopped. The link no longer works.', 'info');
    } else showToast?.('Couldn’t stop sharing. Try again.', 'error');
  };

  const handleReset = async () => {
    setBusy(true);
    const next = await rotate();
    setBusy(false);
    if (next) {
      trackSharedPlans({ name: 'plans_link_reset', props: {} });
      showToast?.('New link ready. The old one no longer works.', 'success');
    } else showToast?.('Couldn’t reset the link. Try again.', 'error');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md" bottomSheet ariaLabel="Share your theater plans">
      <div className="p-card-lg" data-testid="share-plans-modal">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-lg font-bold text-white">Share your theater plans</h2>
          <ModalCloseButton onClick={onClose} />
        </div>
        <p className="text-sm text-gray-400 mb-5">
          Anyone with the link can see which shows you&apos;re seeing and on which days (not the times).
          They don&apos;t need an account. You can stop sharing anytime.
        </p>

        <fieldset className="space-y-2 mb-5">
          <legend className="sr-only">What to share</legend>
          <SectionToggle label="Upcoming" hint="Shows you have a date for" count={counts.booked} checked={showBooked} onChange={on => setSection('booked', on)} />
          <SectionToggle label="Not yet booked" hint="On your watchlist, no date yet" count={counts.unbooked} checked={showUnbooked} onChange={on => setSection('unbooked', on)} />
        </fieldset>

        <ShareLinkPanel
          testIdPrefix="share-plans"
          name={name}
          nameError={nameError}
          onNameChange={setName}
          onNameBlur={saveName}
          titleFor={plansTitle}
          error={error}
          busy={busy}
          canShare={canShare}
          onShare={handleShare}
          live={live}
          url={url}
          onReset={handleReset}
          onStop={handleStop}
        />
      </div>
    </Modal>
  );
}

function SectionToggle({ label, hint, count, checked, onChange }: {
  label: string; hint: string; count: number; checked: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 card p-3 cursor-pointer">
      <span>
        <span className="block text-sm font-semibold text-white">{label} <span className="text-gray-400 font-normal">({count})</span></span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="w-5 h-5 accent-brand" />
    </label>
  );
}
