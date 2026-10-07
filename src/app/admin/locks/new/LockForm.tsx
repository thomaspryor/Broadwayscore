'use client';

import { useEffect, useMemo, useState } from 'react';

interface ShowSearchResult {
  id: string;
  title: string;
  status?: string;
  category?: string;
  od?: string;
  openingDate?: string;
}

interface LockResponse {
  success: boolean;
  showId?: string;
  outletId?: string;
  criticName?: string;
  filename?: string;
  lockedScore?: number;
  priorScore?: number | null;
  lockedReason?: string | null;
  lockedAt?: string | null;
  lockedAcrossTier?: boolean | null;
  pullquoteCleared?: boolean;
  workflowRunUrl?: string;
  warning?: string;
  error?: string;
}

const MIN_REASON_LENGTH = 20;

export default function LockForm({
  initialShowId,
  initialOutletId,
  initialCriticName,
  initialScore,
  initialFilename,
  isEdit,
}: {
  initialShowId: string;
  initialOutletId: string;
  initialCriticName: string;
  initialScore: number | null;
  initialFilename: string;
  isEdit: boolean;
}) {
  // Show picker reuses the /data/search-shows.json source pattern from
  // /admin/ingest's BatchPasteForm — same UX, same data contract.
  const [shows, setShows] = useState<ShowSearchResult[]>([]);
  const [showsLoaded, setShowsLoaded] = useState(false);
  const [showQuery, setShowQuery] = useState('');
  const [selectedShow, setSelectedShow] = useState<ShowSearchResult | null>(null);

  const [outletId, setOutletId] = useState(initialOutletId);
  const [criticName, setCriticName] = useState(initialCriticName);
  const [scoreInput, setScoreInput] = useState(
    initialScore !== null && Number.isFinite(initialScore) ? String(initialScore) : '',
  );
  const [reason, setReason] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<LockResponse | null>(null);

  useEffect(() => {
    fetch('/data/search-shows.json')
      .then((r) => r.json())
      .then((data: ShowSearchResult[]) => {
        setShows(data);
        setShowsLoaded(true);
        if (initialShowId) {
          const match = data.find((s) => s.id === initialShowId);
          if (match) setSelectedShow(match);
        }
      })
      .catch(() => setShowsLoaded(false));
  }, [initialShowId]);

  const showResults = useMemo(() => {
    if (selectedShow || showQuery.trim().length < 2) return [];
    const q = showQuery.toLowerCase();
    return shows
      .filter((s) => s.title?.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const aOpen = a.status === 'open' || a.status === 'previews' ? 0 : 1;
        const bOpen = b.status === 'open' || b.status === 'previews' ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        const aDate = a.openingDate || a.od || '';
        const bDate = b.openingDate || b.od || '';
        return bDate.localeCompare(aDate);
      })
      .slice(0, 8);
  }, [shows, showQuery, selectedShow]);

  const score = scoreInput.trim() ? Number(scoreInput.trim()) : null;
  const scoreOk = score !== null && Number.isFinite(score) && score >= 1 && score <= 100;
  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;
  const ready =
    !!selectedShow &&
    !!outletId.trim() &&
    !!criticName.trim() &&
    scoreOk &&
    reasonOk &&
    !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || !selectedShow || score === null) return;

    setSubmitting(true);
    setResponse(null);

    try {
      const res = await fetch('/api/admin/lock-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showId: selectedShow.id,
          outletId: outletId.trim(),
          criticName: criticName.trim(),
          score,
          reason: reason.trim(),
          action: isEdit ? 'edit-reason' : 'lock',
          // Pass through canonical filename when editing — locks.json's
          // round-trip through generateReviewFilename is lossy for ~4/217
          // catalog entries (criticName backfills, year suffixes).
          ...(initialFilename ? { filename: initialFilename } : {}),
        }),
      });
      const json = (await res.json()) as LockResponse;
      setResponse(json);
      if (json.success) {
        setReason('');
      }
    } catch (err) {
      setResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const buttonLabel = (() => {
    if (submitting) return isEdit ? 'Saving…' : 'Locking…';
    if (!selectedShow) return 'Need: show';
    if (!outletId.trim()) return 'Need: outletId';
    if (!criticName.trim()) return 'Need: critic name';
    if (!scoreOk) return 'Need: score 1-100';
    if (!reasonOk) return `Need: rationale (${reason.trim().length}/${MIN_REASON_LENGTH})`;
    return isEdit ? 'Save changes' : 'Lock score';
  })();

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field label="Show" required>
        {selectedShow ? (
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-surface-raised px-3 py-2.5">
            <div>
              <div className="text-sm text-white">{selectedShow.title}</div>
              <div className="text-[11px] text-gray-500">
                {selectedShow.id}
                {selectedShow.status ? ` · ${selectedShow.status}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedShow(null);
                setShowQuery('');
              }}
              disabled={submitting}
              className="text-[11px] text-brand hover:underline"
            >
              change
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={showQuery}
              onChange={(e) => setShowQuery(e.target.value)}
              placeholder={showsLoaded ? 'Type show title or id to search…' : 'Loading shows…'}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              className={inputClass()}
              disabled={submitting || !showsLoaded}
            />
            {showResults.length > 0 && (
              <div className="rounded-lg border border-white/10 bg-surface-raised divide-y divide-white/5 max-h-60 overflow-y-auto">
                {showResults.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSelectedShow(s);
                      setShowQuery('');
                    }}
                    disabled={submitting}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors"
                  >
                    <div className="text-sm text-white">{s.title}</div>
                    <div className="text-[11px] text-gray-500">
                      {s.id}
                      {s.status ? ` · ${s.status}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Outlet ID" required hint='e.g. "nytimes", "variety", "vulture"'>
          <input
            type="text"
            value={outletId}
            onChange={(e) => setOutletId(e.target.value)}
            placeholder="nytimes"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            disabled={submitting || isEdit}
            className={inputClass()}
          />
        </Field>
        <Field label="Critic name" required hint='Full name as stored, e.g. "Helen Shaw"'>
          <input
            type="text"
            value={criticName}
            onChange={(e) => setCriticName(e.target.value)}
            placeholder="Helen Shaw"
            autoComplete="off"
            autoCapitalize="words"
            autoCorrect="off"
            disabled={submitting || isEdit}
            className={inputClass()}
          />
        </Field>
      </div>

      <Field
        label="Locked score"
        required
        hint={
          isEdit
            ? 'Score is read-only in edit mode. Unlock and re-lock if you need to change the score.'
            : 'Integer 1-100. Crossing a tier boundary clears stale keyPhrases.'
        }
      >
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          value={scoreInput}
          onChange={(e) => setScoreInput(e.target.value)}
          autoComplete="off"
          className={inputClass()}
          disabled={submitting || isEdit}
        />
      </Field>

      <Field
        label="Rationale"
        required
        hint={`Why is this score locked? At least ${MIN_REASON_LENGTH} chars. Reads like a footnote — explicit star rating, structural read, prior-production reuse, etc.`}
      >
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          placeholder='e.g. "Critic gave explicit ★★★★/5 in the second paragraph; LLM ensemble misread the act-2 caveat as Mixed."'
          disabled={submitting}
          className={`${inputClass()} font-mono text-xs leading-5 resize-y`}
        />
        <div
          className={`text-[11px] mt-1 ${
            reasonOk ? 'text-status-open' : 'text-gray-500'
          }`}
        >
          {reason.trim().length} / {MIN_REASON_LENGTH} chars
        </div>
      </Field>

      <button
        type="submit"
        disabled={!ready}
        className={[
          'w-full px-4 py-3 font-semibold rounded-lg transition-colors',
          ready
            ? 'bg-brand text-black hover:bg-brand/90'
            : 'bg-white/5 text-gray-500 cursor-not-allowed',
        ].join(' ')}
      >
        {buttonLabel}
      </button>

      {response && <ResponsePanel response={response} isEdit={isEdit} />}
    </form>
  );
}

function ResponsePanel({ response, isEdit }: { response: LockResponse; isEdit: boolean }) {
  if (response.success) {
    return (
      <div className="rounded-lg border border-status-open/30 bg-status-open/10 p-3 text-xs text-status-open space-y-1">
        <div className="font-semibold">
          ✓ {isEdit ? 'Updated' : 'Locked'} {response.outletId} / {response.criticName} on {response.showId}
        </div>
        <div className="text-gray-300">
          Score: <strong>{response.lockedScore}</strong>
          {response.priorScore !== null && response.priorScore !== response.lockedScore && (
            <> · prior LLM score: <span className="tabular-nums">{response.priorScore}</span></>
          )}
          {response.lockedAcrossTier === true && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded bg-score-tepid/20 text-score-tepid text-[10px] uppercase tracking-wider">
              tier-cross
            </span>
          )}
        </div>
        {response.pullquoteCleared && (
          <div className="text-gray-400">⚠ keyPhrases cleared (tier crossed) — rebuild will pick a fresh pullquote.</div>
        )}
        {response.workflowRunUrl && (
          <div>
            Rebuild dispatched —{' '}
            <a href={response.workflowRunUrl} target="_blank" rel="noopener noreferrer" className="underline">
              view workflow runs
            </a>
            . Live in ~5 min.
          </div>
        )}
        {response.warning && <div className="text-score-tepid">⚠ {response.warning}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-score-skip/30 bg-score-skip/10 p-3 text-xs text-score-skip">
      ✕ {response.error || 'Unknown error'}
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-200 mb-1">
        {label}
        {required && <span className="text-score-skip ml-1">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

function inputClass(): string {
  return [
    'w-full px-3 py-2 text-sm bg-surface-raised border rounded-lg text-white',
    'focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50',
    'border-white/10',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' ');
}
