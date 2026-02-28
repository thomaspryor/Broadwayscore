'use client';

import { Analytics } from '@vercel/analytics/react';
import Script from 'next/script';
import { useEffect, useState } from 'react';

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
const CLARITY_ID = process.env.NEXT_PUBLIC_CLARITY_ID;
const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

export default function AnalyticsWrapper() {
  const [isDisabled, setIsDisabled] = useState(false);

  useEffect(() => {
    const disabled = localStorage.getItem('va-disable') === 'true';
    setIsDisabled(disabled);
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
        const SentrySDK = (window as any).Sentry;
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
              /clarity\.ms/,
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
            beforeSend(event: any) {
              const frames =
                event?.exception?.values?.[0]?.stacktrace?.frames;
              if (!frames || frames.length === 0) return null;
              const hasOurCode = frames.some((f: any) =>
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
      {CLARITY_ID && (
        <Script id="clarity-init" strategy="lazyOnload">
          {`
            (function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
            })(window,document,"clarity","script","${CLARITY_ID}");
          `}
        </Script>
      )}
    </>
  );
}
