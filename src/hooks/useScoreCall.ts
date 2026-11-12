'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { supabaseRestRpc } from '@/lib/supabase-rest';
import { useAuth } from '@/contexts/AuthContext';
import { parseMyCalls } from '@/lib/score-call';

/** A locked call plus the forecast snapshot taken when it locked (null when no forecast existed). */
export interface ScoreCall {
  show_id: string;
  called_score: number;
  forecast: number | null;
  lo80: number | null;
  hi80: number | null;
  locked_at: string;
}

// One shared fetch for hero link, card and strip: they all read the same store.
// loaded = the fetch settled (kept true on failure so existing readers never spin). failed = it settled WITHOUT an answer, so an empty calls map means "unknown", not "no prediction".
interface Store { userId: string | null; calls: Record<string, ScoreCall>; loaded: boolean; failed: boolean; inflight: Promise<void> | null }
const EMPTY: Store = { userId: null, calls: {}, loaded: false, failed: false, inflight: null };
let store: Store = EMPTY;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => store;

async function load(userId: string) {
  if (store.userId === userId && (store.inflight || (store.loaded && !store.failed))) return store.inflight ?? undefined;
  // A response only lands if it is still the current request: a sign-out or a different user signing
  // in meanwhile replaces store.inflight, so a late answer for the old user is dropped.
  const ref: { p?: Promise<void> } = {};
  const p: Promise<void> = (ref.p = (async () => {
    const parsed = parseMyCalls(await supabaseRestRpc<ScoreCall[]>('get_my_score_calls').catch(() => ({ data: null, error: new Error('network') })));
    if (store.inflight !== ref.p) return;
    // A failed load keeps any calls already known (a lock this session) and is retryable.
    // Locked calls never change, so calls this session already holds win over a read that may predate them.
    const held = store.userId === userId ? store.calls : {};
    store = { userId, calls: { ...(parsed.ok ? (parsed.calls as Record<string, ScoreCall>) : {}), ...held }, loaded: true, failed: !parsed.ok, inflight: null };
    emit();
  })());
  store = { userId, calls: store.userId === userId ? store.calls : {}, loaded: false, failed: false, inflight: p };
  return p;
}

export type LockResult = { ok: true; call: ScoreCall } | { ok: false; reason: 'already_called' | 'calls_closed' | 'not_open' | 'error' };

export function useScoreCall(showId: string) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (userId) void load(userId);
    else if (store.userId) { store = EMPTY; emit(); }
  }, [userId]);

  const lock = useCallback(async (score: number): Promise<LockResult> => {
    const { data, error } = await supabaseRestRpc<ScoreCall[]>('lock_score_call', { p_show_id: showId, p_score: score });
    // Signed out (or switched user) while the request was pending: the server saved it, but nothing about it may enter the in-memory store.
    const stale = !!userId && store.userId !== userId;
    if (error) {
      const m = error.message || '';
      if (m.includes('already_called')) { if (stale) return { ok: false, reason: 'already_called' }; store = { ...store, loaded: false, failed: false, inflight: null }; if (userId) await load(userId); return { ok: false, reason: 'already_called' }; }
      if (m.includes('calls_closed')) return { ok: false, reason: 'calls_closed' };
      if (m.includes('not_open')) return { ok: false, reason: 'not_open' };
      return { ok: false, reason: 'error' };
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { ok: false, reason: 'error' };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const call: ScoreCall = { show_id: showId, called_score: row.called_score, forecast: num(row.forecast), lo80: num(row.lo80), hi80: num(row.hi80), locked_at: String(row.locked_at ?? '') };
    if (stale) return { ok: true, call };
    store = { ...store, userId, calls: { ...store.calls, [showId]: call }, loaded: true };
    emit();
    return { ok: true, call };
  }, [showId, userId]);

  const retry = useCallback(() => { if (userId) { store = { ...store, loaded: false, failed: false, inflight: null }; void load(userId); } }, [userId]);

  return { signedIn: !!userId, retry, loadFailed: !!userId && s.userId === userId && s.failed, loaded: !userId || (s.userId === userId && s.loaded), call: userId && s.userId === userId ? s.calls[showId] ?? null : null, lock };
}
