'use client';

import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Script from 'next/script';
import { useEffect } from 'react';

interface SentryEvent {
  exception?: { values?: Array<{ stacktrace?: { frames?: Array<{ filename?: string }> } }> };
}

declare global {
  interface Window {
    Sentry?: {
      init: (config: Record<string, unknown>) => void;
    };
  }
}

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const POSTHOG_KEY = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';

export default function AnalyticsWrapper() {
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

  // PostHog — 10% sampled session recordings + pageviews + manual events (replaces Clarity)
  // Autocapture/heatmaps/person profiles disabled to stay within free tier.
  useEffect(() => {
    import('posthog-js').then(({ default: posthog }) => {
      if (!posthog.__loaded) {
        posthog.init(POSTHOG_KEY, {
          api_host: 'https://us.i.posthog.com',
          autocapture: false,
          // 'history_change' captures $pageview on client-side route changes
          // (pushState/popstate). `true` only fires on initial load, which
          // caused PostHog to miss ~63% of pageviews in Apr 2026 comparison
          // (25K vs Vercel+GA 67K). App Router navigations need this.
          capture_pageview: 'history_change',
          capture_pageleave: true,
          enable_heatmaps: false,
          person_profiles: 'identified_only',
          session_recording: { maskAllInputs: false, sampleRate: 0.1 },
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
    });
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
            sampleRate: 1.0,
            tracesSampleRate: 0.1,
            allowUrls: [
              /https?:\/\/(www\.)?broadwayscorecard\.com/,
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
              return hasOurCode ? event : null;
            },
          });
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
      <Analytics />
      <SpeedInsights />
      {GA_MEASUREMENT_ID && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
            strategy="lazyOnload"
          />
          <Script id="gtag-init" strategy="lazyOnload">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              var __bwscOwner = false;
              try { __bwscOwner = localStorage.getItem('bwsc-owner') === 'true'; } catch (e) {}
              gtag('config', '${GA_MEASUREMENT_ID}', __bwscOwner ? { traffic_type: 'internal' } : {});
            `}
          </Script>
        </>
      )}
    </>
  );
}
