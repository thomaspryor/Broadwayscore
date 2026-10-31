'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { usePostHogFlag } from '@/lib/hooks';
import { captureEvent } from '@/lib/posthog-events';
import { gaEvent } from '@/lib/analytics/ga-event';
import {
  ADSENSE_CLIENT,
  ADS_FLAG,
  AD_SLOTS,
  type AdRegion,
  type AdSlotName,
  decideAdRender,
  isAutomatedBrowser,
  loadAdSense,
  readAdRegion,
} from '@/lib/ads';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

/**
 * One fixed-size, labeled AdSense unit (BRO-5893, sprint-plan-adsense.md
 * B-T5). Renders NOTHING (no box, no label) unless decideAdRender() says yes
 * AND the AdSense script actually loaded, so the no-ads group, members,
 * UK/EEA/CH visitors, automation and ad-blocker users never see an empty
 * "Advertisement" box. Placement is the caller's choice.
 */
export default function AdSlot({ slot }: { slot: AdSlotName }) {
  const config = AD_SLOTS[slot];
  const { loading: authLoading, isAuthenticated } = useAuth();
  const pathname = usePathname();

  // Browser-only signals; start as "no ads" so SSR and first paint match.
  const [env, setEnv] = useState<{ automated: boolean; region: AdRegion | undefined }>({
    automated: true,
    region: undefined,
  });
  useEffect(() => {
    setEnv({ automated: isAutomatedBrowser(), region: readAdRegion() });
  }, []);

  // Every gate except the flag. Only visitors who could see an ad read the
  // flag, so members, UK/EEA/CH and automation never join an experiment arm.
  const gates = {
    authLoading,
    isAuthenticated,
    automated: env.automated,
    region: env.region,
  };
  const exposable = decideAdRender({ ...gates, variant: 'ads' });
  const variant = usePostHogFlag(ADS_FLAG, exposable);
  const eligible = decideAdRender({ ...gates, variant });

  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scriptReady, setScriptReady] = useState(false);

  useEffect(() => {
    if (!eligible || scriptReady) return;
    const el = sentinelRef.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        loadAdSense().then((ok) => {
          if (!cancelled && ok) setScriptReady(true);
        });
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [eligible, scriptReady]);

  if (!eligible) return null;
  if (!scriptReady) return <div ref={sentinelRef} aria-hidden="true" />;
  // Keyed on the path so client-side navigation gets a fresh unit.
  return <AdUnit key={pathname} slot={slot} client={ADSENSE_CLIENT} />;
}

const UNFILLED_TIMEOUT_MS = 8000;

function AdUnit({ slot, client }: { slot: AdSlotName; client: string }) {
  const { id, width, height } = AD_SLOTS[slot];
  const insRef = useRef<HTMLModElement>(null);
  const [unfilled, setUnfilled] = useState(false);

  useEffect(() => {
    const ins = insRef.current;
    if (!ins) return;
    // Push once per <ins>: StrictMode's dev re-run would otherwise throw
    // "already have ads" and hide a filled unit.
    if (!ins.dataset.bwscPushed) {
      ins.dataset.bwscPushed = '1';
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        setUnfilled(true);
        return;
      }
    }
    // AdSense sets data-ad-status="filled" | "unfilled" on the <ins>.
    let reported = false;
    const check = () => {
      const status = ins.getAttribute('data-ad-status');
      if (status === 'unfilled') setUnfilled(true);
      if (status === 'filled' && !reported) {
        reported = true;
        captureEvent('ad_slot_rendered', { slot });
        gaEvent('ad_slot_rendered', { slot });
      }
    };
    const mo = new MutationObserver(check);
    mo.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
    check();
    // Ad blockers can swap in a stub script that loads fine but never sets a
    // status; collapse rather than leave an empty labeled box.
    const giveUp = window.setTimeout(() => {
      if (!ins.getAttribute('data-ad-status')) setUnfilled(true);
    }, UNFILLED_TIMEOUT_MS);
    return () => {
      mo.disconnect();
      window.clearTimeout(giveUp);
    };
  }, [slot]);

  if (unfilled) return null;

  return (
    <aside
      aria-label="Advertisement"
      className="card bg-surface-raised mx-auto mb-5 sm:mb-8 p-3 flex flex-col items-center"
      style={{ width: width + 24, maxWidth: '100%' }}
      data-testid="ad-slot"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Advertisement</p>
      <ins
        ref={insRef}
        className="adsbygoogle"
        style={{ display: 'inline-block', width, height, maxWidth: '100%' }}
        data-ad-client={client}
        data-ad-slot={id}
      />
    </aside>
  );
}
