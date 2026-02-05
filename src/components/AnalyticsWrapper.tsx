'use client';

import { Analytics } from '@vercel/analytics/react';
import { useEffect, useState } from 'react';

export default function AnalyticsWrapper() {
  const [isDisabled, setIsDisabled] = useState(false);

  useEffect(() => {
    // Check localStorage for opt-out flag
    const disabled = localStorage.getItem('va-disable') === 'true';
    setIsDisabled(disabled);
  }, []);

  // Don't render analytics if user has opted out
  if (isDisabled) {
    return null;
  }

  return <Analytics />;
}
