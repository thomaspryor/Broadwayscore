'use client';

import { useEffect } from 'react';
import { reportPageCrash } from '@/lib/ugc-analytics';

/**
 * Last-resort boundary for a crash in the root layout itself (app/error.tsx
 * only covers pages below it). It replaces the whole document, so the site's
 * stylesheet is not guaranteed to be there: plain inline styles only.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { reportPageCrash(error, 'root'); }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', background: 'black', color: 'white', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 420, margin: '0 auto', padding: '20vh 16px 0', textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, marginBottom: 12 }}>Something went wrong</h1>
          <p style={{ color: 'silver', marginBottom: 24 }}>The site ran into an unexpected error. Try again, or reload the page.</p>
          <button
            type="button"
            onClick={() => reset()}
            style={{ padding: '12px 24px', fontWeight: 600, borderRadius: 8, border: 0, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
