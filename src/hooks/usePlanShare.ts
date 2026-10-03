'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseRestRpc, supabaseRestSelect, supabaseRestUpdate, supabaseRestUpsert } from '@/lib/supabase-rest';
import { planShareUrl } from '@/lib/shared-plans/share-url';

/**
 * The signed-in user's Shared Plans link (BRO-4481). Same method names as the
 * iOS app's hooks/usePlanShare.ts.
 *
 * Follows the CLIENT CONTRACT in supabase/migrations/20261001_plan_shares.sql:
 *   - create with an upsert that always carries display_name;
 *   - change settings with PATCH;
 *   - never send `token` (the database mints it); reset via rotate().
 *
 * `mock` keeps everything in memory for /my-shows?mock=1 (visual QA).
 */
export interface PlanShare {
  token: string;
  enabled: boolean;
  show_booked: boolean;
  show_unbooked: boolean;
  display_name: string;
}

export type PlanSharePatch = Partial<Pick<PlanShare, 'enabled' | 'show_booked' | 'show_unbooked' | 'display_name'>>;

const COLUMNS = 'token,enabled,show_booked,show_unbooked,display_name';

export function usePlanShare(userId: string | null, opts: { mock?: boolean } = {}) {
  const { mock = false } = opts;
  const [share, setShare] = useState<PlanShare | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId || mock) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabaseRestSelect<PlanShare>('plan_shares', `user_id=eq.${userId}&select=${COLUMNS}`);
    if (err) setError(err.message);
    else setShare(data?.[0] ?? null);
    setLoading(false);
  }, [userId, mock]);

  useEffect(() => { load(); }, [load]);

  /**
   * Create (or re-enable) the share; returns its public URL. Re-enabling a
   * STOPPED share mints a new link: "Stop sharing" promises the link stops
   * working, and sharing again later (maybe with different people) must not
   * quietly revive it for everyone who had the old one (ship-check 2026-10-03).
   */
  const ensure = useCallback(async (s: { displayName: string; showBooked: boolean; showUnbooked: boolean }): Promise<string | null> => {
    if (!userId) return null;
    setError(null);
    const wasStopped = !!share && !share.enabled;
    if (mock) {
      const fresh = share?.token === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32);
      const next: PlanShare = {
        token: wasStopped ? fresh : share?.token ?? 'f'.repeat(32), enabled: true,
        show_booked: s.showBooked, show_unbooked: s.showUnbooked, display_name: s.displayName.trim(),
      };
      setShare(next);
      return planShareUrl(next.token);
    }
    const { data, error: err } = await supabaseRestUpsert('plan_shares', {
      user_id: userId,
      display_name: s.displayName.trim(),
      show_booked: s.showBooked,
      show_unbooked: s.showUnbooked,
      enabled: true,
    }, 'user_id');
    if (err || !data) { setError(err?.message ?? 'Could not create the link'); return null; }
    const row = data as unknown as PlanShare;
    if (wasStopped) {
      const { data: token, error: rotErr } = await supabaseRestRpc<string>('rotate_plan_share_token');
      if (rotErr || !token) {
        // Sharing is back on with the OLD link; turn it off again rather than
        // hand out a link the owner believes is dead.
        await supabaseRestUpdate('plan_shares', `user_id=eq.${userId}`, { enabled: false });
        setShare({ ...row, enabled: false });
        setError(rotErr?.message ?? 'Could not create a new link');
        return null;
      }
      row.token = token;
    }
    setShare(row);
    return planShareUrl(row.token);
  }, [userId, mock, share]);

  /** Change settings (toggles, name, stop sharing). */
  const update = useCallback(async (patch: PlanSharePatch): Promise<boolean> => {
    if (!userId || !share) return false;
    setError(null);
    const prev = share;
    setShare({ ...share, ...patch });
    if (mock) return true;
    const { error: err } = await supabaseRestUpdate('plan_shares', `user_id=eq.${userId}`, patch);
    if (err) { setShare(prev); setError(err.message); return false; }
    return true;
  }, [userId, mock, share]);

  /** New link; the old one stops working. Returns the new URL. */
  const rotate = useCallback(async (): Promise<string | null> => {
    if (!userId || !share) return null;
    setError(null);
    if (mock) {
      const token = share.token === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32);
      setShare({ ...share, token });
      return planShareUrl(token);
    }
    const { data, error: err } = await supabaseRestRpc<string>('rotate_plan_share_token');
    if (err || !data) { setError(err?.message ?? 'Could not reset the link'); return null; }
    setShare({ ...share, token: data });
    return planShareUrl(data);
  }, [userId, mock, share]);

  return {
    share,
    url: share ? planShareUrl(share.token) : null,
    loading,
    error,
    ensure,
    update,
    rotate,
    reload: load,
  };
}
