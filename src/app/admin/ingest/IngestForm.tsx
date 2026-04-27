'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseScore } from '@/lib/admin-ingest-score';

interface DetectionResult {
  outletId: string | null;
  outletDisplayName: string | null;
  criticName: string | null;
  publishDate: string | null;
  showId: string | null;
  showTitle: string | null;
  showConfidence: 'high' | 'medium' | 'low' | null;
  showCandidates: Array<{ id: string; title: string; openingDate: string | null }>;
  warnings: string[];
}

interface IngestResponse {
  success: boolean;
  path?: string;
  outletId?: string;
  criticName?: string;
  showId?: string;
  publishDate?: string | null;
  filename?: string;
  commitSha?: string;
  workflowRunUrl?: string;
  collisionDetail?: unknown;
  error?: string;
  warning?: string;
  detectionWarnings?: string[];
  pendingReason?: string;
  dispatchedWorkflow?: string;
  // True when the committed file has no humanReviewScore and no
  // extractor-populated originalScore — i.e. LLM scoring is required before
  // the review can render on the live page. Batch mode reads this from each
  // slot's response and sets dispatch mode accordingly.
  needsScoring?: boolean;
}

interface LogEntry {
  id: string;
  startedAt: number;
  url: string;
  // Set after success
  showId?: string;
  outletId?: string;
  criticName?: string;
  commitSha?: string;
  // Status
  status: 'submitting' | 'saved' | 'failed';
  error?: string;
  warningCount?: number;
  // UX hints (Lost Boys 2026-04-27 ship-check Gap 8): show the operator
  // which workflow was dispatched + ETA, plus surface byline-fail rows
  // distinctly so they don't get lost in the success list.
  dispatchedWorkflow?: string;
  pendingReason?: string;
}

type Mode = 'single' | 'batch';

export default function IngestForm() {
  const [mode, setMode] = useState<Mode>('single');
  const [submissionLog, setSubmissionLog] = useState<LogEntry[]>([]);

  return (
    <div className="space-y-5">
      {submissionLog.length > 0 && <SubmissionLog entries={submissionLog} />}

      <ModeToggle mode={mode} onChange={setMode} />

      {mode === 'single' ? (
        <SinglePasteForm
          onResult={pushLog}
          onUpdate={updateLog}
        />
      ) : (
        <BatchPasteForm onResult={pushLog} onUpdate={updateLog} />
      )}
    </div>
  );

  function pushLog(entry: LogEntry) {
    setSubmissionLog(prev => [entry, ...prev].slice(0, 10));
  }
  function updateLog(id: string, patch: Partial<LogEntry>) {
    setSubmissionLog(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  }
}

// ─── Mode toggle ────────────────────────────────────────────────────

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-surface-raised/40 p-0.5 text-xs">
      {(['single', 'batch'] as const).map(m => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={[
            'px-3 py-1.5 rounded-md transition-colors',
            mode === m ? 'bg-brand text-black font-medium' : 'text-gray-400 hover:text-white',
          ].join(' ')}
        >
          {m === 'single' ? 'One review' : 'Paste a batch'}
        </button>
      ))}
    </div>
  );
}

// ─── Submission log ────────────────────────────────────────────────

function SubmissionLog({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="rounded-lg border border-white/10 bg-surface-raised/60 p-3 space-y-2">
      <div className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
        Recent submissions
      </div>
      <ul className="space-y-1">
        {entries.slice(0, 5).map(e => (
          <LogRow key={e.id} entry={e} />
        ))}
      </ul>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const icon =
    entry.status === 'submitting' ? '⏳' : entry.status === 'saved' ? '✓' : '✕';
  const tone =
    entry.status === 'submitting'
      ? 'text-gray-400'
      : entry.status === 'saved'
        ? 'text-status-open'
        : 'text-score-skip';
  const summary =
    entry.status === 'saved' && entry.criticName
      ? `${entry.criticName} · ${entry.outletId} · ${entry.showId}`
      : entry.status === 'submitting'
        ? entry.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)
        : entry.error || 'Failed';

  // Decode the dispatched workflow into operator-friendly ETA (Lost Boys
  // 2026-04-27 ship-check Gap 8). Without this hint, "saved + rebuild
  // dispatched" leaves the operator guessing whether to expect 5 min
  // (rebuild-fast) or 15-20 min (LLM-then-rebuild).
  const eta = entry.status === 'saved' ? describeDispatchEta(entry.dispatchedWorkflow) : null;
  const bylineWarning = entry.status === 'saved' && entry.pendingReason === 'no-byline';

  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`${tone} mt-0.5 shrink-0 w-4`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`${tone} truncate`}>{summary}</div>
        {entry.status === 'failed' && entry.error && (
          <div className="text-[11px] text-gray-500 truncate">{entry.url}</div>
        )}
        {bylineWarning && (
          <div className="text-[11px] text-score-tepid mt-0.5">
            ⚠ Byline not detected — saved as &quot;Unknown&quot;. Edit the file to set criticName, then re-rebuild.
          </div>
        )}
        {eta && (
          <div className={`text-[11px] mt-0.5 ${eta.tone}`}>
            {eta.label}
          </div>
        )}
      </div>
      <span className="text-[11px] text-gray-500 shrink-0 tabular-nums">
        {new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
    </li>
  );
}

/**
 * Map the dispatched workflow filename to the operator-facing ETA hint.
 * rebuild-fast.yml means a score is already on the file; pipeline takes
 * ~5 min to live. llm-ensemble-score.yml means we need to score from
 * fullText first; pipeline takes ~15-20 min to live.
 */
function describeDispatchEta(workflow?: string): { label: string; tone: string } | null {
  if (!workflow) return null;
  if (workflow === 'rebuild-fast.yml') {
    return {
      label: '🚀 Fast path — live in ~5 min (rebuild-fast)',
      tone: 'text-status-open',
    };
  }
  if (workflow === 'llm-ensemble-score.yml') {
    return {
      label: '🤖 LLM scoring — live in ~15-20 min (ensemble-then-rebuild)',
      tone: 'text-gray-400',
    };
  }
  return { label: `Dispatched ${workflow}`, tone: 'text-gray-500' };
}

// ─── Single-paste form ──────────────────────────────────────────────

function SinglePasteForm({
  onResult,
  onUpdate,
}: {
  onResult: (e: LogEntry) => void;
  onUpdate: (id: string, patch: Partial<LogEntry>) => void;
}) {
  const [url, setUrl] = useState('');
  const [fullText, setFullText] = useState('');
  const [scoreInput, setScoreInput] = useState('');

  const [detected, setDetected] = useState<DetectionResult | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [showIdOverride, setShowIdOverride] = useState('');
  const [criticOverride, setCriticOverride] = useState('');
  const [publishDateOverride, setPublishDateOverride] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [forceClearStale, setForceClearStale] = useState(false);

  const detectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const runDetection = useCallback(async (currentUrl: string, currentText: string) => {
    if (!currentUrl.trim() || currentText.trim().length < 50) {
      setDetected(null);
      return;
    }
    try {
      new URL(currentUrl);
    } catch {
      setDetected(null);
      return;
    }
    setDetectLoading(true);
    try {
      const res = await fetch('/api/admin/ingest-review/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: currentUrl.trim(), fullText: currentText }),
      });
      if (res.ok) {
        const data = (await res.json()) as DetectionResult;
        setDetected(data);
      } else {
        setDetected(null);
      }
    } catch {
      setDetected(null);
    } finally {
      setDetectLoading(false);
    }
  }, []);

  useEffect(() => {
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    detectTimerRef.current = setTimeout(() => {
      void runDetection(url, fullText);
    }, 400);
    return () => {
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    };
  }, [url, fullText, runDetection]);

  const effectiveShowId = showIdOverride.trim() || detected?.showId || '';
  const effectiveShowTitle =
    detected?.showCandidates?.find(c => c.id === effectiveShowId)?.title || detected?.showTitle || '';
  const effectiveCritic = criticOverride.trim() || detected?.criticName || '';
  const effectivePublishDate = publishDateOverride.trim() || detected?.publishDate || '';
  const effectiveOutlet = detected?.outletId || '';
  const effectiveOutletName = detected?.outletDisplayName || '';

  const parsedScore = useMemo(() => {
    if (!scoreInput.trim()) return null;
    return parseScore(scoreInput);
  }, [scoreInput]);

  const missingPieces: string[] = [];
  if (!url.trim()) missingPieces.push('review URL');
  if (fullText.trim().length < 50) missingPieces.push('review text');
  if (!effectiveOutlet) missingPieces.push('outlet (URL not from a recognized site)');
  if (!effectiveShowId) missingPieces.push('show');
  if (!effectiveCritic) missingPieces.push('critic name');

  const readyToSubmit = missingPieces.length === 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!readyToSubmit || submitting) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    onResult({ id, startedAt, url: url.trim(), status: 'submitting' });

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/ingest-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          fullText: fullText.trim(),
          showId: effectiveShowId,
          criticName: effectiveCritic,
          publishDate: effectivePublishDate || null,
          originalScore: scoreInput.trim() || null,
          forceClearStale,
        }),
      });
      const json = (await res.json()) as IngestResponse;
      if (json.success) {
        onUpdate(id, {
          status: 'saved',
          showId: json.showId,
          outletId: json.outletId,
          criticName: json.criticName,
          commitSha: json.commitSha,
          warningCount: (json.detectionWarnings || []).length,
          dispatchedWorkflow: json.dispatchedWorkflow,
          pendingReason: json.pendingReason,
        });
        // Clear inputs so user can paste the next one
        setUrl('');
        setFullText('');
        setScoreInput('');
        setShowIdOverride('');
        setCriticOverride('');
        setPublishDateOverride('');
        setDetected(null);
        setForceClearStale(false);
      } else {
        onUpdate(id, { status: 'failed', error: json.error || 'Unknown error' });
      }
    } catch (err) {
      onUpdate(id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const buttonLabel = submitting
    ? 'Submitting…'
    : !readyToSubmit
      ? `Need: ${missingPieces[0]}`
      : 'Submit review';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Field label="Review URL" required>
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          autoComplete="off"
          className={inputClass()}
          disabled={submitting}
          placeholder="https://www.nytimes.com/2026/04/23/theater/..."
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>

      <Field label="Full review text" required>
        <textarea
          value={fullText}
          onChange={e => setFullText(e.target.value)}
          rows={12}
          className={`${inputClass()} font-mono text-xs leading-5 resize-y`}
          disabled={submitting}
          placeholder="Paste the entire review here, including the byline if visible…"
        />
        {fullText.length > 0 && (
          <div className="text-xs text-gray-500 mt-1">{fullText.length.toLocaleString()} characters</div>
        )}
      </Field>

      <DetectedSection
        detected={detected}
        loading={detectLoading}
        url={url}
        fullText={fullText}
        showIdOverride={showIdOverride}
        setShowIdOverride={setShowIdOverride}
        criticOverride={criticOverride}
        setCriticOverride={setCriticOverride}
        publishDateOverride={publishDateOverride}
        setPublishDateOverride={setPublishDateOverride}
        effectiveShowId={effectiveShowId}
        effectiveShowTitle={effectiveShowTitle}
        effectiveCritic={effectiveCritic}
        effectivePublishDate={effectivePublishDate}
        effectiveOutlet={effectiveOutlet}
        effectiveOutletName={effectiveOutletName}
        disabled={submitting}
      />

      <Field
        label="Critic's stated score"
        hint="Optional. Type it as written in the review (e.g. “4/5 stars”, “★★★★”, “A-”, “90/100”). If the review doesn't state a score, leave blank — our LLM will score the text."
      >
        <input
          type="text"
          value={scoreInput}
          onChange={e => setScoreInput(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          className={inputClass()}
          disabled={submitting}
          placeholder="e.g. 5/5 stars, ★★★★, A-, 90/100"
        />
        {scoreInput.trim() && (
          <div className="mt-1.5 text-xs">
            {parsedScore ? (
              <span className="text-status-open">
                ✓ Will be saved as <strong>{parsedScore.score}/100</strong> (original:{' '}
                <code className="text-gray-300">{scoreInput.trim()}</code>)
              </span>
            ) : (
              <span className="text-score-tepid">
                Couldn&apos;t recognize this rating format. Either fix it or leave blank.
              </span>
            )}
          </div>
        )}
      </Field>

      <details className="rounded-lg border border-white/5 bg-surface-raised/40">
        <summary className="px-4 py-2.5 text-xs text-gray-400 cursor-pointer hover:text-gray-200 select-none">
          Advanced options
        </summary>
        <div className="px-4 pb-3 pt-1 space-y-2">
          <label className="flex items-start gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={forceClearStale}
              onChange={e => setForceClearStale(e.target.checked)}
              disabled={submitting}
              className="accent-brand mt-0.5"
            />
            <span>
              Override existing wrong-production flag — only check this if you know the existing
              file for this outlet+critic was tagged for a different production and you want to
              replace it.
            </span>
          </label>
        </div>
      </details>

      <button
        type="submit"
        disabled={!readyToSubmit || submitting}
        className={[
          'w-full px-4 py-3 font-semibold rounded-lg transition-colors',
          readyToSubmit && !submitting
            ? 'bg-brand text-black hover:bg-brand/90'
            : 'bg-white/5 text-gray-500 cursor-not-allowed',
        ].join(' ')}
      >
        {buttonLabel}
      </button>
      {!readyToSubmit && missingPieces.length > 1 && (
        <ul className="-mt-3 text-xs text-gray-500 space-y-0.5">
          <li className="text-gray-400">Also missing:</li>
          {missingPieces.slice(1).map((p, i) => (
            <li key={i}>· {p}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

// ─── Batch form: same-show, N (URL+text) slot pairs ───────────────
//
// Single-show batch redesigned 2026-04-26 after Joe Turner opening night.
// Old delimited-paste model (`---` separator + URL on first line + Show: line)
// caused a paste-error class of bugs (Cititour text in Culture Sauce slot).
// New model: pick the show ONCE at the top, then fill in N (URL, fullText)
// pairs as separate inputs. Eliminates paste confusion entirely.

interface ReviewSlot {
  id: string;
  url: string;
  fullText: string;
  scoreInput: string;
}

interface ShowSearchResult {
  id: string;
  title: string;
  slug?: string;
  status?: string;
  category?: string;
  od?: string;
  openingDate?: string;
  venue?: string;
}

function BatchPasteForm({
  onResult,
  onUpdate,
}: {
  onResult: (e: LogEntry) => void;
  onUpdate: (id: string, patch: Partial<LogEntry>) => void;
}) {
  // Show picker
  const [showQuery, setShowQuery] = useState('');
  const [shows, setShows] = useState<ShowSearchResult[]>([]);
  const [selectedShow, setSelectedShow] = useState<ShowSearchResult | null>(null);
  const [showsLoaded, setShowsLoaded] = useState(false);

  // Slots — start with 2
  const [slots, setSlots] = useState<ReviewSlot[]>(() => [
    { id: makeSlotId(), url: '', fullText: '', scoreInput: '' },
    { id: makeSlotId(), url: '', fullText: '', scoreInput: '' },
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // Lazy-load shows.json
  useEffect(() => {
    if (showsLoaded) return;
    fetch('/data/search-shows.json')
      .then(r => r.json())
      .then((data: ShowSearchResult[]) => {
        setShows(data);
        setShowsLoaded(true);
      })
      .catch(() => setShowsLoaded(false));
  }, [showsLoaded]);

  const showResults = useMemo(() => {
    if (!selectedShow && showQuery.trim().length >= 2) {
      const q = showQuery.toLowerCase();
      // Prefer open Broadway/West End; recently-opened first
      return shows
        .filter(s => s.title?.toLowerCase().includes(q))
        .sort((a, b) => {
          const aOpen = a.status === 'open' || a.status === 'previews' ? 0 : 1;
          const bOpen = b.status === 'open' || b.status === 'previews' ? 0 : 1;
          if (aOpen !== bOpen) return aOpen - bOpen;
          const aDate = a.openingDate || a.od || '';
          const bDate = b.openingDate || b.od || '';
          return bDate.localeCompare(aDate);
        })
        .slice(0, 8);
    }
    return [];
  }, [shows, showQuery, selectedShow]);

  const validSlots = useMemo(
    () =>
      slots.filter(
        s => s.url.trim() && isValidUrl(s.url) && s.fullText.trim().length >= 50,
      ),
    [slots],
  );
  const invalidCount = slots.filter(s => s.url.trim() || s.fullText.trim()).length - validSlots.length;
  const readyToSubmit = !!selectedShow && validSlots.length > 0;

  function updateSlot(id: string, patch: Partial<ReviewSlot>) {
    setSlots(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
  }
  function addSlot() {
    setSlots(prev => [...prev, { id: makeSlotId(), url: '', fullText: '', scoreInput: '' }]);
  }
  function removeSlot(id: string) {
    setSlots(prev => (prev.length <= 1 ? prev : prev.filter(s => s.id !== id)));
  }

  async function handleSubmitAll(event: React.FormEvent) {
    event.preventDefault();
    if (!readyToSubmit || submitting || !selectedShow) return;

    setSubmitting(true);
    setProgress({ done: 0, total: validSlots.length });
    let successCount = 0;
    let failureCount = 0;
    // Track whether ANY successful slot needs LLM scoring. If so, the post-
    // batch dispatch must target llm-ensemble-score.yml (with fast_rebuild=true)
    // — dispatching rebuild-fast.yml directly would commit unscored reviews
    // that never render on the live page (Lost Boys 2026-04-26 Issue #5).
    let anyNeedsScoring = false;

    // Phase 1: commit each review with skipDispatch=true. The show is FIXED
    // at the form level so every entry gets the same showId — no per-slot
    // detection ambiguity.
    for (let i = 0; i < validSlots.length; i++) {
      const slot = validSlots[i];
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      onResult({ id, startedAt: Date.now(), url: slot.url, status: 'submitting' });

      try {
        const res = await fetch('/api/admin/ingest-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: slot.url.trim(),
            fullText: slot.fullText.trim(),
            showId: selectedShow.id,
            originalScore: slot.scoreInput.trim() || null,
            skipDispatch: true,
          }),
        });
        const json = (await res.json()) as IngestResponse;
        if (json.success) {
          successCount++;
          if (json.needsScoring) anyNeedsScoring = true;
          onUpdate(id, {
            status: 'saved',
            showId: json.showId,
            outletId: json.outletId,
            criticName: json.criticName,
            commitSha: json.commitSha,
            warningCount: (json.detectionWarnings || []).length,
            // Per-slot dispatch info — batch dispatches a single workflow at
            // the end so this is per-FILE state (committed yes, but the
            // batch-end dispatch tells the operator the actual ETA).
            pendingReason: json.pendingReason,
          });
        } else {
          failureCount++;
          onUpdate(id, { status: 'failed', error: json.error || 'Unknown error' });
        }
      } catch (err) {
        failureCount++;
        onUpdate(id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      setProgress({ done: i + 1, total: validSlots.length });
    }

    // Phase 2: ONE dispatch covering all the commits. Skip only if literally
    // zero succeeded. When any committed file lacks scoring, route to
    // llm-ensemble-score.yml (which auto-triggers rebuild-fast on completion);
    // otherwise dispatch rebuild-fast directly.
    if (successCount > 0) {
      const dispatchId = `${Date.now()}-dispatch-${Math.random().toString(36).slice(2, 6)}`;
      const dispatchMode: 'rebuild' | 'score-then-rebuild' = anyNeedsScoring
        ? 'score-then-rebuild'
        : 'rebuild';
      const dispatchLabel = anyNeedsScoring
        ? `Score + rebuild ${successCount} review${successCount === 1 ? '' : 's'} for ${selectedShow.title}`
        : `Rebuild ${successCount} review${successCount === 1 ? '' : 's'} for ${selectedShow.title}`;
      onResult({
        id: dispatchId,
        startedAt: Date.now(),
        url: dispatchLabel,
        status: 'submitting',
      });
      try {
        const res = await fetch('/api/admin/dispatch-rebuild', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: dispatchMode,
            show_id: selectedShow.id,
            reason: `admin-ingest-ui batch: ${successCount} reviews for ${selectedShow.id}${failureCount ? ` (${failureCount} failed)` : ''}`,
          }),
        });
        const json = (await res.json()) as {
          success: boolean;
          workflowRunUrl?: string;
          dispatchedWorkflow?: string;
          error?: string;
        };
        if (json.success) {
          onUpdate(dispatchId, {
            status: 'saved',
            criticName: `${successCount} review${successCount === 1 ? '' : 's'}`,
            outletId: anyNeedsScoring ? 'score-then-rebuild' : 'rebuild',
            showId: 'dispatched',
            dispatchedWorkflow: json.dispatchedWorkflow,
          });
        } else {
          const fallbackCmd = anyNeedsScoring
            ? `gh workflow run "LLM Ensemble Score Reviews" -f show_id=${selectedShow.id} -f fast_rebuild=true`
            : `gh workflow run "Rebuild Reviews (Fast)"`;
          onUpdate(dispatchId, {
            status: 'failed',
            error: `Reviews committed but dispatch failed: ${json.error}. Trigger manually: ${fallbackCmd}`,
          });
        }
      } catch (err) {
        onUpdate(dispatchId, {
          status: 'failed',
          error: `Reviews committed but dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Reset slots that succeeded; keep failed ones so operator can edit + retry.
    if (failureCount === 0) {
      setSlots([
        { id: makeSlotId(), url: '', fullText: '', scoreInput: '' },
        { id: makeSlotId(), url: '', fullText: '', scoreInput: '' },
      ]);
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmitAll} className="space-y-5">
      {/* Show picker */}
      <Field label="Show" required hint="All reviews in this batch will be attached to this show.">
        {selectedShow ? (
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-surface-raised px-3 py-2.5">
            <div>
              <div className="text-sm text-white">{selectedShow.title}</div>
              <div className="text-[11px] text-gray-500">
                {selectedShow.id}
                {selectedShow.openingDate || selectedShow.od ? ` · opened ${selectedShow.openingDate || selectedShow.od}` : ''}
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
              onChange={e => setShowQuery(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={showsLoaded ? 'Type show title to search…' : 'Loading shows…'}
              className={inputClass()}
              disabled={submitting || !showsLoaded}
            />
            {showResults.length > 0 && (
              <div className="rounded-lg border border-white/10 bg-surface-raised divide-y divide-white/5 max-h-72 overflow-y-auto">
                {showResults.map(s => (
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
                      {s.openingDate || s.od ? ` · opened ${s.openingDate || s.od}` : ''}
                      {s.status ? ` · ${s.status}` : ''}
                      {s.category ? ` · ${s.category}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {showQuery.trim().length >= 2 && showResults.length === 0 && showsLoaded && (
              <div className="text-xs text-gray-500">No matches.</div>
            )}
          </div>
        )}
      </Field>

      {/* Slot list */}
      {selectedShow && (
        <>
          <div className="space-y-4">
            {slots.map((slot, idx) => (
              <SlotEditor
                key={slot.id}
                index={idx}
                slot={slot}
                onChange={patch => updateSlot(slot.id, patch)}
                onRemove={slots.length > 1 ? () => removeSlot(slot.id) : undefined}
                disabled={submitting}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={addSlot}
            disabled={submitting}
            className="text-sm text-brand hover:underline disabled:opacity-50"
          >
            + Add another review
          </button>

          {(validSlots.length > 0 || invalidCount > 0) && (
            <div className="text-xs text-gray-400">
              <strong className="text-status-open">{validSlots.length} ready</strong>
              {invalidCount > 0 && (
                <span className="text-score-tepid"> · {invalidCount} incomplete (need URL + text ≥50ch)</span>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={!readyToSubmit || submitting}
            className={[
              'w-full px-4 py-3 font-semibold rounded-lg transition-colors',
              readyToSubmit && !submitting
                ? 'bg-brand text-black hover:bg-brand/90'
                : 'bg-white/5 text-gray-500 cursor-not-allowed',
            ].join(' ')}
          >
            {submitting
              ? `Submitting ${progress.done} of ${progress.total}…`
              : !readyToSubmit
                ? 'Fill in at least one review (URL + text)'
                : `Submit ${validSlots.length} review${validSlots.length === 1 ? '' : 's'} for ${selectedShow.title}`}
          </button>
        </>
      )}
    </form>
  );
}

function SlotEditor({
  index,
  slot,
  onChange,
  onRemove,
  disabled,
}: {
  index: number;
  slot: ReviewSlot;
  onChange: (patch: Partial<ReviewSlot>) => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const urlOk = !slot.url.trim() || isValidUrl(slot.url);
  const textOk = !slot.fullText.trim() || slot.fullText.trim().length >= 50;
  const parsedScore = slot.scoreInput.trim() ? parseScore(slot.scoreInput.trim()) : null;
  return (
    <div className="rounded-lg border border-white/10 bg-surface-raised p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-gray-500">Review {index + 1}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="text-[11px] text-gray-500 hover:text-score-skip"
          >
            remove
          </button>
        )}
      </div>
      <input
        type="url"
        value={slot.url}
        onChange={e => onChange({ url: e.target.value })}
        placeholder="https://www.nytimes.com/2026/04/23/theater/..."
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        className={inputClass()}
      />
      {!urlOk && <p className="text-[11px] text-score-skip">Not a valid URL</p>}
      <textarea
        value={slot.fullText}
        onChange={e => onChange({ fullText: e.target.value })}
        rows={6}
        placeholder="Paste the full review text…"
        disabled={disabled}
        className={`${inputClass()} font-mono text-xs leading-5 resize-y`}
      />
      <div className="flex items-center justify-between text-[11px]">
        <span className={textOk ? 'text-gray-500' : 'text-score-skip'}>
          {slot.fullText.length > 0
            ? `${slot.fullText.length.toLocaleString()} chars${textOk ? '' : ' (need ≥50)'}`
            : ''}
        </span>
      </div>
      <input
        type="text"
        value={slot.scoreInput}
        onChange={e => onChange({ scoreInput: e.target.value })}
        placeholder="Score if stated (e.g. 4/5, ★★★★, A-, 90/100) — leave blank to let LLM score"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        className={`${inputClass()} text-xs`}
      />
      {slot.scoreInput.trim() && (
        <div className="text-[11px]">
          {parsedScore ? (
            <span className="text-status-open">
              ✓ Will be saved as <strong>{parsedScore.score}/100</strong> (original:{' '}
              <code className="text-gray-300">{slot.scoreInput.trim()}</code>)
            </span>
          ) : (
            <span className="text-score-tepid">
              Couldn&apos;t recognize this rating format. Fix it or leave blank.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function makeSlotId() {
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

// ─── Detected section (single-paste only) ─────────────────────────

function DetectedSection({
  detected,
  loading,
  url,
  fullText,
  showIdOverride,
  setShowIdOverride,
  criticOverride,
  setCriticOverride,
  publishDateOverride,
  setPublishDateOverride,
  effectiveShowId,
  effectiveShowTitle,
  effectiveCritic,
  effectivePublishDate,
  effectiveOutlet,
  effectiveOutletName,
  disabled,
}: {
  detected: DetectionResult | null;
  loading: boolean;
  url: string;
  fullText: string;
  showIdOverride: string;
  setShowIdOverride: (v: string) => void;
  criticOverride: string;
  setCriticOverride: (v: string) => void;
  publishDateOverride: string;
  setPublishDateOverride: (v: string) => void;
  effectiveShowId: string;
  effectiveShowTitle: string;
  effectiveCritic: string;
  effectivePublishDate: string;
  effectiveOutlet: string;
  effectiveOutletName: string;
  disabled: boolean;
}) {
  const idle = !url.trim() || fullText.trim().length < 50;

  if (idle) {
    return (
      <div className="rounded-lg border border-white/5 bg-surface-raised/40 p-4 text-xs text-gray-500">
        Once you paste a URL and the review text, we&apos;ll auto-fill outlet, critic, show, and
        date here. You&apos;ll be able to fix anything that&apos;s wrong before submitting.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-surface-raised p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Detected from URL + text</h3>
        {loading && <span className="text-xs text-gray-500">Detecting…</span>}
      </div>

      <DetectedField
        label="Outlet"
        value={
          effectiveOutlet
            ? effectiveOutletName
              ? `${effectiveOutletName} (${effectiveOutlet})`
              : effectiveOutlet
            : null
        }
        missingHint="URL not from a recognized outlet — try a different review URL"
      />

      <DetectedField
        label="Show"
        value={effectiveShowId ? `${effectiveShowTitle} (${effectiveShowId})` : null}
        editable
        override={showIdOverride}
        setOverride={setShowIdOverride}
        placeholder="show ID, e.g. the-rocky-horror-show-2026"
        disabled={disabled}
        confidence={detected?.showConfidence}
        candidates={detected?.showCandidates}
        onPickCandidate={id => setShowIdOverride(id)}
        missingHint="Couldn't find a matching show — type the show ID below"
      />

      <DetectedField
        label="Critic"
        value={effectiveCritic || null}
        editable
        override={criticOverride}
        setOverride={setCriticOverride}
        placeholder="critic's full name, e.g. Helen Shaw"
        disabled={disabled}
        autoExpandWhenMissing
        missingHint="Couldn't find a “By [Name]” byline — type the critic's name below"
      />

      <DetectedField
        label="Publish date"
        value={effectivePublishDate || null}
        editable
        override={publishDateOverride}
        setOverride={setPublishDateOverride}
        placeholder="YYYY-MM-DD"
        disabled={disabled}
        missingHint="Date not in URL — type it below if you want it set"
        optional
      />
    </div>
  );
}

function DetectedField({
  label,
  value,
  editable,
  override,
  setOverride,
  placeholder,
  disabled,
  confidence,
  candidates,
  onPickCandidate,
  missingHint,
  autoExpandWhenMissing,
  optional,
}: {
  label: string;
  value: string | null;
  editable?: boolean;
  override?: string;
  setOverride?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  confidence?: 'high' | 'medium' | 'low' | null;
  candidates?: Array<{ id: string; title: string; openingDate: string | null }>;
  onPickCandidate?: (id: string) => void;
  missingHint?: string;
  autoExpandWhenMissing?: boolean;
  optional?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const inputVisible = editable && (editing || (override && override.length > 0) || (autoExpandWhenMissing && !value));

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm font-medium text-gray-300">{label}</span>
        {confidence && value && (
          <span
            className={[
              'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded',
              confidence === 'high' ? 'bg-status-open/20 text-status-open' : 'bg-score-tepid/20 text-score-tepid',
            ].join(' ')}
          >
            {confidence === 'high' ? '✓' : '?'} {confidence}
          </span>
        )}
      </div>

      {!inputVisible && value ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-white">{value}</span>
          {editable && setOverride && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={disabled}
              className="text-[11px] text-brand hover:underline"
            >
              change
            </button>
          )}
        </div>
      ) : null}

      {inputVisible && setOverride ? (
        <div className="space-y-1">
          {!value && missingHint && (
            <div className="text-xs text-score-tepid mb-1">⚠ {missingHint}</div>
          )}
          <input
            type="text"
            value={override ?? ''}
            onChange={e => setOverride(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize={label === 'Critic' ? 'words' : 'off'}
            className={`${inputClass()} text-sm`}
          />
          {editing && value && (
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setOverride('');
              }}
              className="text-[11px] text-gray-400 hover:text-gray-200"
            >
              cancel
            </button>
          )}
        </div>
      ) : null}

      {!inputVisible && !value && !editable && missingHint && (
        <div className="text-xs text-score-skip">⚠ {missingHint}</div>
      )}
      {!inputVisible && !value && optional && !override?.length && (
        <div className="text-xs text-gray-500">— {missingHint || 'not detected (optional)'}</div>
      )}

      {candidates && candidates.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="text-[11px] text-gray-500 self-center mr-1">Or pick:</span>
          {candidates.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPickCandidate?.(c.id)}
              disabled={disabled}
              className="text-[11px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200"
            >
              {c.title}
              {c.openingDate && <span className="text-gray-500"> · {c.openingDate}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Misc ──────────────────────────────────────────────────────────

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
