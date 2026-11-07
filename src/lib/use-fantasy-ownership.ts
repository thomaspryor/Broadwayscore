'use client';

import { useEffect, useState } from 'react';

export interface FantasyOwnership {
  totalEntries: number;
  published: boolean;
  shows: Record<string, { count: number; pct: number }>;
}

// One request per page load, shared by every picker slot and guide card.
let pending: Promise<FantasyOwnership | null> | null = null;

function loadOwnership(): Promise<FantasyOwnership | null> {
  if (!pending) {
    pending = fetch('/api/fantasy/ownership')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => (d && d.published ? (d as FantasyOwnership) : null))
      .catch(() => {
        pending = null; // a failed fetch is retried by the next mount
        return null;
      });
  }
  return pending;
}

/** Most-picked shares (BRO-4338), or null while loading / before enough rosters exist. */
export function useFantasyOwnership(): FantasyOwnership | null {
  const [data, setData] = useState<FantasyOwnership | null>(null);
  useEffect(() => {
    let live = true;
    loadOwnership().then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, []);
  return data;
}
