'use client';

import { useEffect, useState } from 'react';

/**
 * Current time (ms) that is safe to use for date-derived rendering in a
 * statically built page.
 *
 * Returns `renderedAt` (the server's Date.now() when the page was built, passed
 * down as a prop) during SSR and hydration, so the first client render matches
 * the static HTML, then switches to the viewer's real clock after mount.
 *
 * Reading `new Date()` directly in render makes the client disagree with HTML
 * built on an earlier day: a "Closing Soon" row drops a show overnight, React
 * throws a hydration error (#418) and regenerates the tree, and the page's
 * first clicks are lost (BRO-5419).
 */
export function useHydrationSafeNow(renderedAt: number): number {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  return now;
}
