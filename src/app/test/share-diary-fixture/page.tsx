'use client';

import { useState } from 'react';
import ShareDiaryModal from '@/components/user/ShareDiaryModal';

/**
 * Browser fixture for the owner's Shared Diary sheet (BRO-4566), in mock
 * mode: no sign-in, nothing written. Guarded by /test's TestGuard.
 */
export default function ShareDiaryFixturePage() {
  const [open, setOpen] = useState(true);
  const [toast, setToast] = useState('');
  return (
    <div className="p-6">
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} data-testid="share-diary-open">Share</button>
      <p className="text-sm text-gray-400 mt-3" data-testid="fixture-toast">{toast}</p>
      <ShareDiaryModal
        isOpen={open}
        onClose={() => setOpen(false)}
        userId="mock-user"
        profileName="Tom Pryor"
        showsSeen={42}
        mock
        showToast={msg => setToast(msg)}
      />
    </div>
  );
}
