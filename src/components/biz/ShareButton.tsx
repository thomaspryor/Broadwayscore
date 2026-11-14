'use client';

/**
 * Share button for the Profitability Scorecard pages (BRO-6149). Phones get the native
 * share sheet; desktop copies the link and says so on the button itself (no
 * ToastProvider needed, it is only mounted when user accounts are on). The
 * shared URL is always the public one (SITE_URL), never the demo origin.
 */
import { useEffect, useRef, useState } from 'react';
import { shareOrCopy } from '@/lib/share-link';
import { SITE_URL } from '@/lib/site-url';

type Status = 'idle' | 'copied' | 'failed';

export default function ShareButton({ path, title, className = '' }: { path: string; title: string; className?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const url = `${SITE_URL}${path}`;

  useEffect(() => () => clearTimeout(timer.current), []);

  async function onClick() {
    const outcome = await shareOrCopy({ title, url });
    if (outcome === 'copied' || outcome === 'failed') {
      setStatus(outcome);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus('idle'), outcome === 'failed' ? 6000 : 2500);
    }
  }

  return (
    <div className={`inline-flex flex-col items-start ${className}`}>
      <button type="button" onClick={onClick} className="btn-secondary h-11 gap-2 whitespace-nowrap" data-testid="biz-share">
        {status === 'copied' ? (
          <svg className="w-4 h-4 text-status-open" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4m0 0L8 6m4-4v13" />
          </svg>
        )}
        {status === 'copied' ? 'Link copied' : 'Share'}
      </button>
      <span role="status" aria-live="polite" className={status === 'failed' ? 'text-xs text-gray-400 mt-1 break-all max-w-xs' : 'sr-only'}>
        {status === 'copied' ? 'Link copied' : status === 'failed' ? url : ''}
      </span>
    </div>
  );
}
