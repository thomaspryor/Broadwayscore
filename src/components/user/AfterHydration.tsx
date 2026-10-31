'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Renders children only after hydration. Per-card overlays (bookmark, hover
 * rating stars) were ~6KB of SVG per card in the server HTML, which pushed
 * 700-show lists past Googlebot's 2MB fetch limit (BRO-5968). They are absolutely
 * positioned over the poster, so mounting them late does not shift layout.
 */
export default function AfterHydration({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : null;
}
