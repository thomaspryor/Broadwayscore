'use client';

import { useEffect, useRef, useState } from 'react';
import { captureEvent } from '@/lib/posthog-events';
import { gaEvent } from '@/lib/analytics/ga-event';

/**
 * "Share your team" on the draft confirmation screen (BRO-4338). Phones get
 * the system share sheet with the roster image attached; elsewhere the image
 * downloads so it can be posted by hand.
 */
export default function FantasyShareButton({ picks, teamName }: { picks: string[]; teamName: string }) {
  const [busy, setBusy] = useState(false);
  const imageUrl = `/api/fantasy/share-image?${new URLSearchParams({ picks: picks.join(','), team: teamName.trim() })}`;
  const shareText = 'My Broadway Fantasy League team. Draft yours:';
  const pageUrl = 'https://broadwayscorecard.com/fantasy';
  const image = useRef<Promise<Blob> | null>(null);

  // Fetch the image as soon as the confirmation screen shows. iOS Safari only
  // opens the share sheet while the tap's user activation is fresh, and a
  // cold image render after the tap can outlast it.
  const loadImage = () => {
    if (!image.current) {
      image.current = fetch(imageUrl).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
      image.current.catch(() => { image.current = null; });
    }
    return image.current;
  };
  useEffect(() => { loadImage(); }, [imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  async function share() {
    setBusy(true);
    try {
      const blob = await loadImage();
      const file = new File([blob], 'my-fantasy-team.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: `${shareText} ${pageUrl}` });
        captureEvent('fantasy_team_shared', { method: 'share_sheet' });
        gaEvent('fantasy_team_shared', { method: 'share_sheet' });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        captureEvent('fantasy_team_shared', { method: 'download' });
        gaEvent('fantasy_team_shared', { method: 'download' });
      }
    } catch (err) {
      // Closing the share sheet rejects with AbortError: not a failure.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        captureEvent('fantasy_team_share_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        gaEvent('fantasy_team_share_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        window.open(imageUrl, '_blank', 'noopener');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={share} disabled={busy} className="px-6 py-3 whitespace-nowrap bg-surface-raised border border-white/10 text-white font-semibold rounded-lg hover:bg-surface-overlay transition-colors disabled:opacity-60" data-testid="fantasy-share">
      {busy ? 'Preparing image…' : 'Share your team'}
    </button>
  );
}
