'use client';

import { useState } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import type { DeleteAccountResult } from '@/contexts/AuthContext';

interface DeleteAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 'deleted' closes the dialog; anything else leaves it open with an error. */
  onConfirm: () => Promise<DeleteAccountResult>;
  /** Offered in place of Delete when the session expired: sign out, then sign in. */
  onSignInAgain: () => void;
}

/**
 * Confirmation step for permanent account deletion. The work happens in the
 * delete-account edge function; this only asks, shows progress, and reports a
 * failure in place so the user can retry or back out.
 */
export default function DeleteAccountDialog({ isOpen, onClose, onConfirm, onSignInAgain }: DeleteAccountDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState<Exclude<DeleteAccountResult, 'deleted'> | null>(null);

  const close = () => {
    if (deleting) return;
    setFailed(null);
    onClose();
  };

  const confirm = async () => {
    setDeleting(true);
    setFailed(null);
    const result = await onConfirm().catch((): DeleteAccountResult => 'failed');
    setDeleting(false);
    if (result === 'deleted') onClose();
    else setFailed(result);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      zIndex={90}
      maxWidth="sm"
      closeOnBackdrop={!deleting}
      closeOnEscape={!deleting}
      ariaLabel="Delete account"
    >
      <div className="p-6">
        <ModalCloseButton onClick={close} className="absolute top-4 right-4" />

        <h2 className="text-lg font-bold text-white mb-2 pr-8">Delete your account?</h2>
        <p className="text-sm text-gray-400 leading-relaxed">
          This permanently deletes your account and everything you saved with it: ratings, reviews, watchlist,
          lists and imported shows. It can&apos;t be undone.
        </p>

        {failed && (
          <div role="alert" className="mt-4 px-3 py-2 rounded-lg bg-score-skip/10 border border-score-skip/20 text-xs text-score-skip">
            {/* The edge function deletes table by table, so a failure can land
                after some data is gone. Say so; a retry picks up the rest. */}
            {failed === 'session_expired'
              ? 'Your sign-in has expired, so nothing was deleted. Sign in again, then choose Delete account from the menu.'
              : 'Something went wrong and we couldn\u2019t finish deleting your account. Some of your data may already be gone. Try again to finish.'}
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={close}
            disabled={deleting}
            className="btn border border-white/10 text-gray-300 hover:text-white hover:bg-surface-overlay text-sm disabled:opacity-50"
          >
            Keep my account
          </button>
          {failed === 'session_expired' ? (
            <button
              type="button"
              onClick={() => {
                setFailed(null);
                onSignInAgain();
              }}
              className="btn bg-brand/20 text-white border border-brand/30 hover:bg-brand/30 text-sm"
            >
              Sign in again
            </button>
          ) : (
            <button
              type="button"
              onClick={confirm}
              disabled={deleting}
              className="btn bg-score-skip-bg text-score-skip border border-score-skip/30 hover:bg-score-skip/20 hover:border-score-skip/50 text-sm disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
