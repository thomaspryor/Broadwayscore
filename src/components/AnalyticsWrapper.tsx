'use client';

import { Analytics } from '@vercel/analytics/react';
import Script from 'next/script';
import { useEffect, useState } from 'react';

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export default function AnalyticsWrapper() {
  const [isDisabled, setIsDisabled] = useState(false);

  useEffect(() => {
    const disabled = localStorage.getItem('va-disable') === 'true';
    setIsDisabled(disabled);
  }, []);

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
    </>
  );
}
