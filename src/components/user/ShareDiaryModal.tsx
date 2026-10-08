'use client';

import { useEffect, useState } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import { useDiaryShare } from '@/hooks/useDiaryShare';
import { usePlanShare } from '@/hooks/usePlanShare';
import { shareOrCopy } from '@/lib/share-link';
import { defaultShareName, validateShareName } from '@/lib/share-links/share-name';
import { trackSharedDiary } from '@/lib/shared-diary/events';
import { diarySummary, diaryTitle } from '@/lib/shared-diary/view-model';
import ShareLinkPanel from './ShareLinkPanel';

/**
 * Owner sheet for Shared Diary (BRO-4566, docs/specs/shared-diary.md): the
 * name friends see, share via the native sheet or copy, preview, reset or
 * stop. Dates and star ratings only; notes stay private (the notes switch is
 * release 2). `showsSeen` comes from selectSharedDiary so it matches what
 * friends will see.
 */
interface Props {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  profileName: string | null;
  showsSeen: number;
  mock?: boolean;
  showToast?: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export default function ShareDiaryModal({ isOpen, onClose, userId, profileName, showsSeen, mock, showToast }: Props) {
  const { share, url, loading, error, ensure, update, rotate } = useDiaryShare(isOpen ? userId : null, { mock });
  // A first diary share suggests the name already used on the plans link.
  const { share: planShare } = usePlanShare(isOpen && !share ? userId : null, { mock });
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  // Seed the name: the saved diary share, else the plans link's name, else
  // the profile's first name. Stops once the owner types.
  const suggestedName = share?.display_name ?? planShare?.display_name ?? defaultShareName(profileName);
  useEffect(() => {
    if (!nameTouched) setName(suggestedName);
  }, [suggestedName, nameTouched]);

  const nameError = validateShareName(name);
  const live = !!share?.enabled;
  const canShare = !busy && !loading && !nameError;

  const saveName = async () => {
    if (!share || nameError || name.trim() === share.display_name) return;
    if (!(await update({ display_name: name.trim() }))) showToast?.('Couldn’t save your name.', 'error');
  };

  const handleShare = async () => {
    if (!canShare) return;
    setBusy(true);
    try {
      const reuse = live && share?.display_name === name.trim();
      const created = !live;
      const link = reuse ? url : await ensure({ display_name: name });
      if (!link) { showToast?.('Couldn’t create your link. Try again.', 'error'); return; }
      if (!live) trackSharedDiary({ name: 'diary_share_enabled', props: { shows: showsSeen } });
      const outcome = await shareOrCopy({ title: 'My theater diary', url: link });
      if (outcome === 'shared') trackSharedDiary({ name: 'diary_shared', props: { method: 'native-sheet' } });
      if (outcome === 'copied') {
        trackSharedDiary({ name: 'diary_shared', props: { method: 'copy' } });
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
      trackSharedDiary({ name: 'diary_share_stopped', props: {} });
      showToast?.('Sharing stopped. The link no longer works.', 'info');
    } else showToast?.('Couldn’t stop sharing. Try again.', 'error');
  };

  const handleReset = async () => {
    setBusy(true);
    const next = await rotate();
    setBusy(false);
    if (next) {
      trackSharedDiary({ name: 'diary_link_reset', props: {} });
      showToast?.('New link ready. The old one no longer works.', 'success');
    } else showToast?.('Couldn’t reset the link. Try again.', 'error');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md" bottomSheet ariaLabel="Share your theater diary">
      <div className="p-card-lg" data-testid="share-diary-modal">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-lg font-bold text-white">Share your theater diary</h2>
          <ModalCloseButton onClick={onClose} />
        </div>
        <p className="text-sm text-gray-400 mb-5">
          Anyone with the link can see the shows you&apos;ve seen, with your dates and star ratings.
          Your notes stay private. They don&apos;t need an account. You can stop sharing anytime.
        </p>

        <div className="card p-3 mb-5 text-sm text-white" data-testid="share-diary-count">
          {diarySummary(showsSeen)}
        </div>

        <ShareLinkPanel
          testIdPrefix="share-diary"
          name={name}
          nameError={nameError}
          onNameChange={n => { setNameTouched(true); setName(n); }}
          onNameBlur={saveName}
          titleFor={diaryTitle}
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
