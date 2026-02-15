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
  useEffect(() => {
    if (isDisabled || !SENTRY_DSN) return;
    const script = document.createElement('script');
    script.src = 'https://browser.sentry-cdn.com/8.52.1/bundle.min.js';
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      if (typeof (window as any).Sentry !== 'undefined') {
        (window as any).Sentry.init({
          dsn: SENTRY_DSN,
          sampleRate: 1.0,
          tracesSampleRate: 0.1,
        });
      }
    };
    document.head.appendChild(script);
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
            strategy="afterInteractive"
          />
          <Script id="gtag-init" strategy="afterInteractive">
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
        <Script id="clarity-init" strategy="afterInteractive">
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
