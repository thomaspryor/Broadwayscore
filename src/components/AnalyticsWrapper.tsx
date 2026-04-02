'use client';

import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Script from 'next/script';
import { useEffect, useState } from 'react';

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
  const [isDisabled, setIsDisabled] = useState(false);

  useEffect(() => {
    const disabled = localStorage.getItem('va-disable') === 'true';
    setIsDisabled(disabled);
  }, []);

  // PostHog — session recordings, heatmaps, autocapture (replaces Clarity)
  // Runs unconditionally on mount — independent of the Vercel Analytics va-disable flag.
  useEffect(() => {
    import('posthog-js').then(({ default: posthog }) => {
      if (posthog.__loaded) return; // guard against React Strict Mode double-invoke
      posthog.init(POSTHOG_KEY, {
        api_host: 'https://us.i.posthog.com',
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
        enable_heatmaps: true,
        person_profiles: 'always',
        session_recording: { maskAllInputs: false },
        loaded: (ph) => {
          if (process.env.NODE_ENV === 'development') ph.opt_out_capturing();
          // Expose on window so TicketLink and other components can call posthog.capture()
          (window as unknown as Record<string, unknown>).posthog = ph;
        },
      });
    });
  }, []);

  // Lightweight Sentry init — loads SDK from CDN, no npm dependency
  // Deferred to idle time to avoid blocking critical rendering (TBT reduction)
  // Filters out browser extension noise so only real site errors are reported
  useEffect(() => {
    if (isDisabled || !SENTRY_DSN) return;

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
  }, [isDisabled]);

  if (isDisabled) {
    return null;
  }

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
              gtag('config', '${GA_MEASUREMENT_ID}');
            `}
          </Script>
        </>
      )}
    </>
  );
}
