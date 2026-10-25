'use client';

/**
 * GatedDownloadButtons - Download buttons for exports that do not exist yet.
 *
 * Clicking opens a closable waitlist modal (BRO-4623 P1-15; it used to be a
 * blocking "Pro" wall). When the modal does not open (the visitor is already
 * subscribed or signed in, or another modal is up), the button would otherwise
 * do nothing at all, so an inline note says downloads are coming soon.
 */

import { useState } from 'react';
import { useProGate } from '@/contexts/ProGateContext';

type DownloadKind = 'json_download' | 'csv_download';

export default function GatedDownloadButtons() {
  const { triggerGate, trackBlockedAction } = useProGate();
  const [showNote, setShowNote] = useState(false);

  const handleClick = (kind: DownloadKind) => {
    trackBlockedAction(kind);
    const opened = triggerGate(kind);
    setShowNote(!opened);
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => handleClick('json_download')}
          className="px-4 py-2 bg-brand/20 text-brand rounded-lg text-sm font-medium hover:bg-brand/30 transition flex items-center gap-1.5"
          aria-label="Download JSON, coming soon"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          JSON
          <span className="text-xs text-brand/60">(soon)</span>
        </button>
        <button
          type="button"
          onClick={() => handleClick('csv_download')}
          className="px-4 py-2 bg-brand/20 text-brand rounded-lg text-sm font-medium hover:bg-brand/30 transition flex items-center gap-1.5"
          aria-label="Download CSV, coming soon"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          CSV
          <span className="text-xs text-brand/60">(soon)</span>
        </button>
      </div>
      {showNote && (
        <p className="text-xs text-gray-400" role="status">
          Data downloads are coming soon.
        </p>
      )}
    </div>
  );
}
