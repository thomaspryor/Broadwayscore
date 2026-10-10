'use client';

import { useState } from 'react';
import { SHARE_NAME_MAX } from '@/lib/share-links/share-name';

/**
 * The part of an owner share sheet every private link has (plans, diary):
 * the name friends see, the Share button, and once live, Preview, Reset link
 * and Stop sharing. The sheet owns the state and the calls; this only lays
 * them out, so both sheets behave and look the same.
 */
interface Props {
  /** data-testid prefix: `share-plans` → share-plans-share, share-plans-live, share-plans-stop. */
  testIdPrefix: string;
  name: string;
  nameError: string | null;
  onNameChange: (name: string) => void;
  onNameBlur: () => void;
  /** What friends see as the page title for a name ("Tom’s theater plans"). */
  titleFor: (name: string) => string;
  error: string | null;
  busy: boolean;
  canShare: boolean;
  onShare: () => void;
  live: boolean;
  url: string | null;
  onReset: () => Promise<void>;
  onStop: () => void;
}

export default function ShareLinkPanel({
  testIdPrefix, name, nameError, onNameChange, onNameBlur, titleFor,
  error, busy, canShare, onShare, live, url, onReset, onStop,
}: Props) {
  const [confirmReset, setConfirmReset] = useState(false);
  const reset = async () => {
    await onReset();
    setConfirmReset(false);
  };
  const helpId = `${testIdPrefix}-name-help`;

  return (
    <>
      <label className="block mb-5">
        <span className="block text-xs font-semibold uppercase tracking-wide text-gray-300 mb-1.5">Your name on the page</span>
        <input
          type="text"
          value={name}
          maxLength={SHARE_NAME_MAX + 5}
          onChange={e => onNameChange(e.target.value)}
          onBlur={onNameBlur}
          className="search-input"
          placeholder="e.g. Tom"
          aria-invalid={!!nameError}
          aria-describedby={helpId}
        />
        <span id={helpId} className={`block text-xs mt-1 ${nameError && name ? 'text-score-skip' : 'text-gray-500'}`}>
          {nameError && name ? nameError : `Friends see “${titleFor(name.trim() || 'Tom')}”.`}
        </span>
      </label>

      {error && <p className="text-xs text-score-skip mb-3" role="alert">Something went wrong: {error}</p>}

      <button type="button" onClick={onShare} disabled={!canShare} className="btn btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed" data-testid={`${testIdPrefix}-share`}>
        {busy ? 'Working…' : 'Share link'}
      </button>

      {live && url && (
        <div className="mt-5 pt-4 border-t border-white/10 space-y-3" data-testid={`${testIdPrefix}-live`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-status-open font-semibold uppercase tracking-wide">Sharing is on</span>
            <a href={url} target="_blank" rel="noopener noreferrer" className="ph-no-capture text-sm text-brand hover:text-brand-light underline underline-offset-2">Preview</a>
          </div>
          {confirmReset ? (
            <div className="card p-3">
              <p className="text-sm text-gray-300 mb-3">Anyone with the old link will lose access.</p>
              <div className="flex gap-2">
                <button type="button" onClick={reset} disabled={busy} className="btn btn-secondary text-sm">Reset link</button>
                <button type="button" onClick={() => setConfirmReset(false)} className="btn btn-ghost text-sm">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setConfirmReset(true)} disabled={busy} className="btn btn-secondary text-sm">Reset link</button>
              <button type="button" onClick={onStop} disabled={busy} className="btn btn-secondary text-sm" data-testid={`${testIdPrefix}-stop`}>Stop sharing</button>
            </div>
          )}
          <p className="text-xs text-gray-500">Previews already sent in chats stay visible there.</p>
        </div>
      )}
    </>
  );
}
