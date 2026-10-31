'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseRestRpc, supabaseRestSelect, supabaseRestUpdate, supabaseRestUpsert } from '@/lib/supabase-rest';

/**
 * The signed-in user's row in one of the private share tables (plan_shares,
 * diary_shares). One owner per row, keyed by user_id.
 *
 * Follows the CLIENT CONTRACT both migrations share
 * (supabase/migrations/20261001_plan_shares.sql, 20261004_diary_shares.sql):
 *   - create with an upsert that always carries display_name;
 *   - change settings with PATCH;
 *   - never send `token` (the database mints it); reset via the rotate RPC.
 *
 * `mock` keeps everything in memory for /my-shows?mock=1 (visual QA).
 */
export interface ShareRowBase {
  token: string;
  enabled: boolean;
  display_name: string;
}

export interface ShareRowConfig<T extends ShareRowBase> {
  table: string;
  rotateFn: string;
  /** Every column of T, comma-separated, for the select. */
  columns: string;
  url(token: string): string;
  /** The table's column defaults, for a first share in mock mode. */
  defaults: Omit<T, keyof ShareRowBase>;
}

/** display_name always (the contract); any other column only when the sheet sets it, so the database default holds otherwise. */
export type ShareRowSettings<T extends ShareRowBase> = Pick<T, 'display_name'> & Partial<Omit<T, keyof ShareRowBase>>;
export type ShareRowPatch<T extends ShareRowBase> = Partial<Omit<T, 'token'>>;

const MOCK_A = 'f'.repeat(32);
const MOCK_B = 'e'.repeat(32);

/** `config` must be a module-level constant (its fields are hook dependencies). */
export function useShareRow<T extends ShareRowBase>(userId: string | null, config: ShareRowConfig<T>, opts: { mock?: boolean } = {}) {
  const { mock = false } = opts;
  const { table, rotateFn, columns, url: urlFor, defaults } = config;
  const [share, setShare] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId || mock) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabaseRestSelect<T>(table, `user_id=eq.${userId}&select=${columns}`);
    if (err) setError(err.message);
    else setShare(data?.[0] ?? null);
    setLoading(false);
  }, [userId, mock, table, columns]);

  useEffect(() => { load(); }, [load]);

  /**
   * Create (or re-enable) the share; returns its public URL. Re-enabling a
   * STOPPED share mints a new link: "Stop sharing" promises the link stops
   * working, and sharing again later (maybe with different people) must not
   * quietly revive it for everyone who had the old one (ship-check 2026-10-03).
   */
  const ensure = useCallback(async (settings: ShareRowSettings<T>): Promise<string | null> => {
    if (!userId) return null;
    setError(null);
    const wasStopped = !!share && !share.enabled;
    const displayName = settings.display_name.trim();
    if (mock) {
      const fresh = share?.token === MOCK_A ? MOCK_B : MOCK_A;
      const next = {
        ...defaults, ...share, ...settings, display_name: displayName,
        token: wasStopped ? fresh : share?.token ?? MOCK_A, enabled: true,
      } as T;
      setShare(next);
      return urlFor(next.token);
    }
    const { data, error: err } = await supabaseRestUpsert(table, {
      ...settings,
      user_id: userId,
      display_name: displayName,
      enabled: true,
    }, 'user_id');
    if (err || !data) { setError(err?.message ?? 'Could not create the link'); return null; }
    const row = data as unknown as T;
    if (wasStopped) {
      const { data: token, error: rotErr } = await supabaseRestRpc<string>(rotateFn);
      if (rotErr || !token) {
        // Sharing is back on with the OLD link; turn it off again rather than
        // hand out a link the owner believes is dead.
        await supabaseRestUpdate(table, `user_id=eq.${userId}`, { enabled: false });
        setShare({ ...row, enabled: false });
        setError(rotErr?.message ?? 'Could not create a new link');
        return null;
      }
      row.token = token;
    }
    setShare(row);
    return urlFor(row.token);
  }, [userId, mock, share, table, rotateFn, urlFor, defaults]);

  /** Change settings (toggles, name, stop sharing). */
  const update = useCallback(async (patch: ShareRowPatch<T>): Promise<boolean> => {
    if (!userId || !share) return false;
    setError(null);
    const prev = share;
    setShare({ ...share, ...patch });
    if (mock) return true;
    const { error: err } = await supabaseRestUpdate(table, `user_id=eq.${userId}`, patch as Record<string, unknown>);
    if (err) { setShare(prev); setError(err.message); return false; }
    return true;
  }, [userId, mock, share, table]);

  /** New link; the old one stops working. Returns the new URL. */
  const rotate = useCallback(async (): Promise<string | null> => {
    if (!userId || !share) return null;
    setError(null);
    if (mock) {
      const token = share.token === MOCK_A ? MOCK_B : MOCK_A;
      setShare({ ...share, token });
      return urlFor(token);
    }
    const { data, error: err } = await supabaseRestRpc<string>(rotateFn);
    if (err || !data) { setError(err?.message ?? 'Could not reset the link'); return null; }
    setShare({ ...share, token: data });
    return urlFor(data);
  }, [userId, mock, share, rotateFn, urlFor]);

  return {
    share,
    url: share ? urlFor(share.token) : null,
    loading,
    error,
    ensure,
    update,
    rotate,
    reload: load,
  };
}
