'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

export interface LockRecord {
  showId: string;
  outletId: string | null;
  outlet: string | null;
  criticName: string | null;
  filename: string;
  url: string | null;
  lockedScore: number;
  priorScore: number | null;
  lockedReason: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  lockedAcrossTier: boolean | null;
  hasRationale: boolean;
  publishDate: string | null;
}

interface ActionState {
  type: 'idle' | 'submitting' | 'success' | 'error';
  message?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

export default function LocksTable({ locks }: { locks: LockRecord[] }) {
  const [showQuery, setShowQuery] = useState('');
  const [outletQuery, setOutletQuery] = useState('');
  const [criticQuery, setCriticQuery] = useState('');
  const [recentOnly, setRecentOnly] = useState(false);
  const [tierCrossOnly, setTierCrossOnly] = useState(false);
  const [missingRationaleOnly, setMissingRationaleOnly] = useState(false);

  const filtered = useMemo(() => {
    const sq = showQuery.trim().toLowerCase();
    const oq = outletQuery.trim().toLowerCase();
    const cq = criticQuery.trim().toLowerCase();
    const recentCutoff = recentOnly ? Date.now() - SEVEN_DAYS_MS : null;
    return locks.filter((l) => {
      if (sq && !l.showId.toLowerCase().includes(sq)) return false;
      if (oq && !((l.outletId || '').toLowerCase().includes(oq) || (l.outlet || '').toLowerCase().includes(oq))) return false;
      if (cq && !(l.criticName || '').toLowerCase().includes(cq)) return false;
      if (recentCutoff !== null) {
        // Backfilled rows carry sentinel lockedAt timestamps, not real lock
        // events. Excluding lockedBy='backfill' from "recent" prevents 217
        // sentinel rows from drowning the actual recent-locks view, no
        // matter what sentinel date the backfill chose. Belt-and-braces
        // alongside the new pre-feature DEFAULT_LOCKED_AT in
        // scripts/backfill-locked-reasons.js (ship-check 2026-04-27 P1).
        if (l.lockedBy === 'backfill') return false;
        const t = l.lockedAt ? Date.parse(l.lockedAt) : NaN;
        if (!Number.isFinite(t) || t < recentCutoff) return false;
      }
      if (tierCrossOnly && l.lockedAcrossTier !== true) return false;
      if (missingRationaleOnly) {
        if (l.hasRationale && l.lockedReason !== 'pre-2026-04-27 (rationale not captured)') return false;
      }
      return true;
    });
  }, [locks, showQuery, outletQuery, criticQuery, recentOnly, tierCrossOnly, missingRationaleOnly]);

  const grouped = useMemo(() => {
    const map = new Map<string, LockRecord[]>();
    for (const l of filtered) {
      if (!map.has(l.showId)) map.set(l.showId, []);
      map.get(l.showId)!.push(l);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="space-y-4">
      <Filters
        showQuery={showQuery}
        setShowQuery={setShowQuery}
        outletQuery={outletQuery}
        setOutletQuery={setOutletQuery}
        criticQuery={criticQuery}
        setCriticQuery={setCriticQuery}
        recentOnly={recentOnly}
        setRecentOnly={setRecentOnly}
        tierCrossOnly={tierCrossOnly}
        setTierCrossOnly={setTierCrossOnly}
        missingRationaleOnly={missingRationaleOnly}
        setMissingRationaleOnly={setMissingRationaleOnly}
      />

      <div className="text-xs text-gray-400">
        Showing <strong className="text-white">{filtered.length}</strong> of {locks.length} locks across{' '}
        <strong className="text-white">{grouped.length}</strong> show{grouped.length === 1 ? '' : 's'}
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-surface-raised p-6 text-sm text-gray-400 text-center">
          No locks match these filters.
        </div>
      ) : (
        grouped.map(([showId, showLocks]) => (
          <ShowGroup key={showId} showId={showId} locks={showLocks} />
        ))
      )}
    </div>
  );
}

function Filters(props: {
  showQuery: string;
  setShowQuery: (v: string) => void;
  outletQuery: string;
  setOutletQuery: (v: string) => void;
  criticQuery: string;
  setCriticQuery: (v: string) => void;
  recentOnly: boolean;
  setRecentOnly: (v: boolean) => void;
  tierCrossOnly: boolean;
  setTierCrossOnly: (v: boolean) => void;
  missingRationaleOnly: boolean;
  setMissingRationaleOnly: (v: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-surface-raised p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          value={props.showQuery}
          onChange={(e) => props.setShowQuery(e.target.value)}
          placeholder="Filter by show id"
          className={inputClass()}
          autoComplete="off"
          autoCapitalize="off"
        />
        <input
          type="text"
          value={props.outletQuery}
          onChange={(e) => props.setOutletQuery(e.target.value)}
          placeholder="Filter by outlet"
          className={inputClass()}
          autoComplete="off"
          autoCapitalize="off"
        />
        <input
          type="text"
          value={props.criticQuery}
          onChange={(e) => props.setCriticQuery(e.target.value)}
          placeholder="Filter by critic"
          className={inputClass()}
          autoComplete="off"
          autoCapitalize="off"
        />
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <Toggle label="Locked in last 7 days" checked={props.recentOnly} onChange={props.setRecentOnly} />
        <Toggle label="Tier-cross only" checked={props.tierCrossOnly} onChange={props.setTierCrossOnly} />
        <Toggle
          label="Pending rationale only"
          checked={props.missingRationaleOnly}
          onChange={props.setMissingRationaleOnly}
        />
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-gray-300 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-brand"
      />
      {label}
    </label>
  );
}

function ShowGroup({ showId, locks }: { showId: string; locks: LockRecord[] }) {
  return (
    <section className="rounded-lg border border-white/10 bg-surface-raised overflow-hidden">
      <header className="px-4 py-2.5 bg-surface-overlay border-b border-white/10 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-white">{showId}</h2>
        <span className="text-[11px] text-gray-500">
          {locks.length} lock{locks.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="divide-y divide-white/5">
        {locks.map((lock) => (
          <LockRow key={lock.filename} lock={lock} />
        ))}
      </div>
    </section>
  );
}

function LockRow({ lock }: { lock: LockRecord }) {
  const [actionState, setActionState] = useState<ActionState>({ type: 'idle' });
  const [unlockOpen, setUnlockOpen] = useState(false);

  async function unlock() {
    if (!lock.outletId || !lock.criticName) return;
    setActionState({ type: 'submitting' });
    try {
      const res = await fetch('/api/admin/lock-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'unlock',
          showId: lock.showId,
          outletId: lock.outletId,
          criticName: lock.criticName,
          // Pass the canonical filename from locks.json so the endpoint
          // doesn't re-derive it from outletId+criticName — round-trip is
          // lossy for ~4 catalog locks (criticName backfills, year suffixes).
          filename: lock.filename,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (json.success) {
        setActionState({
          type: 'success',
          message: 'Unlocked. Rebuild dispatched — refresh in ~5 min.',
        });
      } else {
        setActionState({ type: 'error', message: json.error || 'Unknown error' });
      }
    } catch (err) {
      setActionState({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const editHref = lock.outletId && lock.criticName
    ? `/admin/locks/new?showId=${encodeURIComponent(lock.showId)}&outletId=${encodeURIComponent(lock.outletId)}&criticName=${encodeURIComponent(lock.criticName)}&score=${lock.lockedScore}&filename=${encodeURIComponent(lock.filename)}&mode=edit`
    : null;

  const tierBadge =
    lock.lockedAcrossTier === true ? (
      <span className="inline-block px-1.5 py-0.5 rounded bg-score-tepid/20 text-score-tepid text-[10px] uppercase tracking-wider">
        tier-cross
      </span>
    ) : null;
  const pendingBadge =
    !lock.hasRationale ||
    lock.lockedReason === 'pre-2026-04-27 (rationale not captured)' ? (
      <span className="inline-block px-1.5 py-0.5 rounded bg-white/10 text-gray-400 text-[10px] uppercase tracking-wider">
        rationale pending
      </span>
    ) : null;

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-white">{lock.criticName || 'Unknown'}</span>
            <span className="text-xs text-gray-400">· {lock.outlet || lock.outletId}</span>
            {tierBadge}
            {pendingBadge}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            Locked at <strong className="text-gray-300 tabular-nums">{lock.lockedScore}</strong>
            {lock.priorScore !== null && lock.priorScore !== lock.lockedScore && (
              <> · prior LLM score <span className="text-gray-400 tabular-nums">{lock.priorScore}</span></>
            )}
            {lock.lockedAt && (
              <> · {formatDate(lock.lockedAt)}</>
            )}
            {lock.lockedBy && <> · by {lock.lockedBy}</>}
          </div>
          <div className="text-xs text-gray-300 mt-1 italic">
            {lock.lockedReason || <span className="text-gray-600">no rationale captured</span>}
          </div>
          {lock.url && (
            <div className="text-[11px] text-gray-600 mt-0.5 truncate">
              <a href={lock.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {lock.url.replace(/^https?:\/\/(www\.)?/, '')}
              </a>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {editHref && (
            <Link href={editHref} className="text-[11px] text-brand hover:underline">
              edit
            </Link>
          )}
          {unlockOpen ? (
            <div className="flex items-center gap-1.5 text-[11px]">
              <button
                onClick={unlock}
                disabled={actionState.type === 'submitting'}
                className="text-score-skip hover:underline disabled:opacity-50"
              >
                confirm unlock
              </button>
              <span className="text-gray-600">·</span>
              <button
                onClick={() => setUnlockOpen(false)}
                disabled={actionState.type === 'submitting'}
                className="text-gray-400 hover:text-white"
              >
                cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setUnlockOpen(true)}
              className="text-[11px] text-gray-500 hover:text-score-skip"
            >
              unlock
            </button>
          )}
        </div>
      </div>
      {actionState.type !== 'idle' && (
        <div
          className={`mt-2 text-[11px] ${
            actionState.type === 'success'
              ? 'text-status-open'
              : actionState.type === 'error'
                ? 'text-score-skip'
                : 'text-gray-400'
          }`}
        >
          {actionState.type === 'submitting' ? 'Unlocking…' : actionState.message}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function inputClass(): string {
  return [
    'w-full px-2.5 py-1.5 text-xs bg-surface border rounded-md text-white',
    'focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50',
    'border-white/10',
  ].join(' ');
}
