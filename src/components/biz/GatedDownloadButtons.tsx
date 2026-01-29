'use client';

/**
 * GatedDownloadButtons - Download buttons that trigger email capture instead of downloading
 * Phase 0: Monetization optionality
 */

import { useProGate } from '@/contexts/ProGateContext';

export default function GatedDownloadButtons() {
  const { triggerGate, trackBlockedAction } = useProGate();

  const handleJsonClick = () => {
    trackBlockedAction('json_download');
    triggerGate('json_download');
  };

  const handleCsvClick = () => {
    trackBlockedAction('csv_download');
    triggerGate('csv_download');
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handleJsonClick}
        className="px-4 py-2 bg-brand/20 text-brand rounded-lg text-sm font-medium hover:bg-brand/30 transition flex items-center gap-1.5"
        aria-label="Download JSON - Coming soon for Pro members"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        JSON
        <span className="text-xs text-brand/60">(Pro)</span>
      </button>
      <button
        onClick={handleCsvClick}
        className="px-4 py-2 bg-brand/20 text-brand rounded-lg text-sm font-medium hover:bg-brand/30 transition flex items-center gap-1.5"
        aria-label="Download CSV - Coming soon for Pro members"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        CSV
        <span className="text-xs text-brand/60">(Pro)</span>
      </button>
    </div>
  );
}
