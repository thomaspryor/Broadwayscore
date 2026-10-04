'use client';

import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { isAuthCallbackPath, isPrivateSharePath, posthogBeforeSend, sentryScrub, vercelBeforeSend } from '@/lib/analytics/redact-url';
import { gaInitScript } from '@/lib/analytics/ga-init-script';
import { applyAnalyticsUser, flushUgcOutbox } from '@/lib/ugc-analytics';

interface SentryEvent {
  exception?: { values?: Array<{ stacktrace?: { frames?: Array<{ filename?: string }> } }> };
}

declare global {
  interface Window {
    Sentry?: {
      init: (config: Record<string, unknown>) => void;
      captureException?: (e: unknown, ctx?: Record<string, unknown>) => void;
      setUser?: (user: { id: string } | null) => void;
    };
  }
}

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const POSTHOG_KEY = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';

export default function AnalyticsWrapper() {
  // Shared Plans privacy (BRO-4481): /plans/<token> is a private link. Every
  // tool below sends through src/lib/analytics/redact-url.ts. On each
  // navigation — client-side ones included, which the init options can't
  // see — replay is stopped on a plans page and GA is switched off there
  // (and back on elsewhere). Links OUT of a plans page load a new document
  // (PrivateShareLayout → LeaveByDocument): a client-side
  // navigation made GA send the plans URL as page_referrer, and it also means
  // Back re-enters plans as a document, never through the router.
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    try {
      const onPlans = isPrivateSharePath(pathname);
      if (onPlans || isAuthCallbackPath(pathname)) {
        (window as unknown as { posthog?: { stopSessionRecording?: () => void } }).posthog?.stopSessionRecording?.();
      }
      if (GA_MEASUREMENT_ID) {
        (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`] = onPlans;
      }
    } catch {
      // analytics must never break navigation
    }
  }, [pathname]);

  // Owner tagging — Real Users analytics lens.
  // ?bwsc-owner=1 once per device persists localStorage.bwsc-owner='true'.
  // Tagged sessions stay in topline counts (Vercel + GA + PostHog) but can be
  // filtered out via PostHog cohort + GA4 internal-traffic comparison.
  // See memory/analytics-real-users-segment.md
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('bwsc-owner') === '1') {
        localStorage.setItem('bwsc-owner', 'true');
      }
    } catch {
      // ignore localStorage / URL parse failures
    }
  }, []);

  // PostHog — 10% sampled session recordings + pageviews + autocapture + manual events
  // Heatmaps + person profiles disabled. Audited 2026-04-10: 74K events/30d = 7.4%
  // of 1M free tier with autocapture ON. Turn autocapture back OFF if monthly
  // events approach 700K (10x current traffic). Recording cost is capped by the
  // 10% sample rate — leave it alone, Sentry covers error debugging.
  // Deferred to idle time (same pattern as Sentry below) — the recorder+surveys
  // bundle (~85KB) was competing with hydration for main-thread time during the
  // LCP-critical window on every page (card #311, 2026-07-21 CWV regression).
  useEffect(() => {
    const loadPostHog = () => {
      import('posthog-js').then(({ default: posthog }) => {
        if (!posthog.__loaded) {
          posthog.init(POSTHOG_KEY, {
            api_host: 'https://us.i.posthog.com',
            autocapture: true,
            // 'history_change' captures $pageview on client-side route changes
            // (pushState/popstate). `true` only fires on initial load, which
            // caused PostHog to miss ~63% of pageviews in Apr 2026 comparison
            // (25K vs Vercel+GA 67K). App Router navigations need this.
            capture_pageview: 'history_change',
            capture_pageleave: true,
            enable_heatmaps: false,
            person_profiles: 'identified_only',
            // Inputs stay visible for UX debugging, except textareas (private
            // rating notes, list descriptions, feedback) and email/password.
            // Displayed personal text (My Shows, diary, the menu's name,
            // saved notes) carries the recorder's default `ph-mask` class;
            // the privacy page promises both, so keep them in step.
            session_recording: {
              maskAllInputs: false,
              maskInputOptions: { password: true, email: true, textarea: true },
              sampleRate: 0.1,
            },
            // Shared Plans privacy (BRO-4481): no replay of a plans page, and
            // every event's URLs/properties go through the token redactor.
            disable_session_recording: isPrivateSharePath(window.location.pathname) || isAuthCallbackPath(window.location.pathname),
            before_send: posthogBeforeSend,
            loaded: (ph) => {
              if (process.env.NODE_ENV === 'development') ph.opt_out_capturing();
            },
          });
        }
        // Stamp every event with is_owner if this device is the owner.
        // register() = super-property, no person profile created (free-tier safe).
        try {
          if (localStorage.getItem('bwsc-owner') === 'true') {
            posthog.register({ is_owner: true });
          }
        } catch {
          // ignore
        }
        // Always expose on window — even if already loaded from a prior render.
        // TicketLink and other components use window.posthog.capture() for native events.
        (window as unknown as Record<string, unknown>).posthog = posthog;
        // Auth may have resolved before PostHog finished its idle-time load,
        // and sign-in/rating events fired before now are waiting to be sent.
        applyAnalyticsUser();
        flushUgcOutbox();
      }).catch(() => {
        // Blocked import (ad blocker / network) — window.posthog stays undefined.
        // Every consumer (TicketButtonsAB, ProGateContext, TicketLink,
        // promo-tracking) already optional-chains + falls back to a labeled
        // 'fallback'/'anonymous' state after its own poll timeout, so this is
        // silent-by-design, not silent-by-accident (adversarial review finding,
        // card #311) — nothing further to do here.
      });
    };

    // Timeout capped lower than Sentry's (below) — a longer cap here delays
    // window.posthog becoming available, which TicketLink polls for (up to
    // 2s, see its own comment) to stamp the Impact subId1 on ticket-CTA
    // hrefs. TicketButtonsAB itself no longer withholds rendering on this
    // (task #1936 — that used to hide the primary CTA for up to 5s, which
    // is what drove rage clicks), so this timeout is now purely an
    // analytics/attribution budget, not a revenue-CTA-visibility one.
    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(loadPostHog, { timeout: 1500 });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timeoutId = setTimeout(loadPostHog, 1500);
    return () => clearTimeout(timeoutId);
  }, []);

  // Lightweight Sentry init — loads SDK from CDN, no npm dependency
  // Deferred to idle time to avoid blocking critical rendering (TBT reduction)
  // Filters out browser extension noise so only real site errors are reported
  useEffect(() => {
    if (!SENTRY_DSN) return;

    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const loadSentry = () => {
      const script = document.createElement('script');
      script.src = 'https://browser.sentry-cdn.com/8.52.1/bundle.min.js';
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        const SentrySDK = window.Sentry;
        if (typeof SentrySDK !== 'undefined') {
          SentrySDK.init({
            dsn: SENTRY_DSN,
            environment: window.location.hostname === 'demo.broadwayscorecard.com' ? 'demo' : 'production',
            sampleRate: 1.0,
            tracesSampleRate: 0.1,
            allowUrls: [
              /https?:\/\/(www\.|demo\.)?broadwayscorecard\.com/,
              /https?:\/\/broadwayscorecard-.*\.vercel\.app/,
            ],
            denyUrls: [
              /extensions?\//i,
              /^chrome(-extension)?:\/\//i,
              /^moz-extension:\/\//i,
              /^safari(-web)?-extension:\/\//i,
              /^webkit-masked-url:\/\//i,
              /translate\.google/,
              /posthog\.com/,
              /googletagmanager\.com/,
            ],
            ignoreErrors: [
              /swal/i,
              /sweetalert/i,
              /invalid origin/i,
              /blocked a frame with origin/i,
              /@context/,
              /ResizeObserver loop/,
              /Loading chunk \d+ failed/,
              /NetworkError when attempting to fetch/,
              /Failed to fetch/,
              /Load failed/,
              /AbortError/,
              /NotAllowedError/,
              /webkit-masked-url/,
              /Script error\.?$/i,
              /Non-Error promise rejection captured/i,
            ],
            beforeSend(event: SentryEvent) {
              const frames =
                event?.exception?.values?.[0]?.stacktrace?.frames;
              if (!frames || frames.length === 0) return null;
              const hasOurCode = frames.some((f) =>
                f.filename &&
                /broadwayscorecard\.(com|vercel\.app)/.test(f.filename)
              );
              return hasOurCode ? sentryScrub(event) : null;
            },
            beforeBreadcrumb: sentryScrub,
          });
          applyAnalyticsUser();
        }
      };
      document.head.appendChild(script);
    };

    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(loadSentry, { timeout: 5000 });
    } else {
      // Safari fallback — no requestIdleCallback support
      timeoutId = setTimeout(loadSentry, 3000);
    }

    return () => {
      if (idleId !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  return (
    <>
      <Analytics beforeSend={vercelBeforeSend} />
      <SpeedInsights beforeSend={vercelBeforeSend} />
      {GA_MEASUREMENT_ID && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
            strategy="lazyOnload"
          />
          {/* Owner tagging + Shared Plans privacy live in gaInitScript (tested). */}
          <Script id="gtag-init" strategy="lazyOnload">
            {gaInitScript(GA_MEASUREMENT_ID)}
          </Script>
        </>
      )}
    </>
  );
}
