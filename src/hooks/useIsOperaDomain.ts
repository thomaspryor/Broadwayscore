'use client';

import { useEffect, useState } from 'react';
import { isOperaDomain } from '@/config/feature-flags';

/**
 * Returns true after hydration if the page is being served from
 * operascorecard.com (or www.operascorecard.com). Always returns false during
 * SSR / first render to avoid hydration mismatch — components using this
 * should render the Broadway-default UI first and conditionally swap after.
 *
 * Usage:
 *   const isOpera = useIsOperaDomain();
 *   return <span>{isOpera ? 'OperaScorecard' : 'BroadwayScorecard'}</span>;
 */
export function useIsOperaDomain(): boolean {
  const [isOpera, setIsOpera] = useState(false);
  useEffect(() => {
    setIsOpera(isOperaDomain());
  }, []);
  return isOpera;
}
