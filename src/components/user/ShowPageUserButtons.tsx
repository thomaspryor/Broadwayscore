'use client';

import dynamic from 'next/dynamic';

// Group A: personalized, auth-dependent — ssr:false so they don't block the
// pre-rendered HTML. Next 15 only allows ssr:false inside a Client Component,
// so the show page imports these wrappers instead of calling dynamic() itself
// (BRO-3203).
export const ShowPageWatchlistButton = dynamic(
  () => import('@/components/user/ShowPageWatchlistButton'),
  { ssr: false }
);
export const ShowPageAddToListButton = dynamic(
  () => import('@/components/user/ShowPageAddToListButton'),
  { ssr: false }
);
