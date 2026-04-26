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
}

type Mode = 'single' | 'batch';

interface BatchEntry {
  url: string;
  fullText: string;
  scoreInput: string;
}

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

  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`${tone} mt-0.5 shrink-0 w-4`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`${tone} truncate`}>{summary}</div>
        {entry.status === 'failed' && entry.error && (
          <div className="text-[11px] text-gray-500 truncate">{entry.url}</div>
        )}
      </div>
      <span className="text-[11px] text-gray-500 shrink-0 tabular-nums">
        {new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
    </li>
  );
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

// ─── Batch-paste form ──────────────────────────────────────────────

function BatchPasteForm({
  onResult,
  onUpdate,
}: {
  onResult: (e: LogEntry) => void;
  onUpdate: (id: string, patch: Partial<LogEntry>) => void;
}) {
  const [batchInput, setBatchInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const entries = useMemo(() => parseBatch(batchInput), [batchInput]);
  const validCount = entries.filter(e => isEntryValid(e)).length;
  const invalidCount = entries.length - validCount;

  async function handleSubmitAll(event: React.FormEvent) {
    event.preventDefault();
    if (validCount === 0 || submitting) return;
    setSubmitting(true);
    setProgress({ done: 0, total: validCount });

    const validEntries = entries.filter(isEntryValid);
    let successCount = 0;
    let failureCount = 0;

    // Phase 1: commit all files. Each ingest-review call uses skipDispatch=true
    // so we don't fire N parallel rebuilds (the per-run concurrency groups in
    // rebuild-fast.yml mean N dispatches = N parallel rebuilds = wasted compute
    // + push contention on reviews.json).
    for (let i = 0; i < validEntries.length; i++) {
      const entry = validEntries[i];
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const startedAt = Date.now();
      onResult({ id, startedAt, url: entry.url, status: 'submitting' });

      try {
        const res = await fetch('/api/admin/ingest-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: entry.url,
            fullText: entry.fullText,
            originalScore: entry.scoreInput || null,
            skipDispatch: true,
          }),
        });
        const json = (await res.json()) as IngestResponse;
        if (json.success) {
          successCount++;
          onUpdate(id, {
            status: 'saved',
            showId: json.showId,
            outletId: json.outletId,
            criticName: json.criticName,
            commitSha: json.commitSha,
            warningCount: (json.detectionWarnings || []).length,
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
      setProgress({ done: i + 1, total: validEntries.length });
    }

    // Phase 2: dispatch a SINGLE rebuild covering all the files we just
    // committed. Fire even if some entries failed — the successful commits
    // still need to be rebuilt. Skip only if literally zero commits succeeded.
    if (successCount > 0) {
      const dispatchId = `${Date.now()}-dispatch-${Math.random().toString(36).slice(2, 6)}`;
      onResult({
        id: dispatchId,
        startedAt: Date.now(),
        url: `Rebuild ${successCount} review${successCount === 1 ? '' : 's'}`,
        status: 'submitting',
      });
      try {
        const res = await fetch('/api/admin/dispatch-rebuild', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: `admin-ingest-ui batch: ${successCount} reviews${failureCount ? ` (${failureCount} failed)` : ''}`,
          }),
        });
        const json = (await res.json()) as { success: boolean; workflowRunUrl?: string; error?: string };
        if (json.success) {
          onUpdate(dispatchId, {
            status: 'saved',
            criticName: `${successCount} review${successCount === 1 ? '' : 's'}`,
            outletId: 'rebuild',
            showId: 'dispatched',
          });
        } else {
          onUpdate(dispatchId, {
            status: 'failed',
            error: `Reviews committed but rebuild dispatch failed: ${json.error}. Trigger manually: gh workflow run "Rebuild Reviews (Fast)"`,
          });
        }
      } catch (err) {
        onUpdate(dispatchId, {
          status: 'failed',
          error: `Reviews committed but rebuild dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Clear the batch input only if everything succeeded — keep it on partial
    // failure so the operator can re-edit and re-run only the failed entries.
    if (failureCount === 0) {
      setBatchInput('');
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmitAll} className="space-y-5">
      <div className="rounded-lg border border-white/10 bg-surface-raised/40 p-3 text-xs text-gray-400 space-y-1">
        <div className="font-semibold text-gray-200">Batch format</div>
        <p>
          Separate each review with a line of <code className="text-brand">---</code>. For each
          review: put the URL on its own line, then the full review text. Optionally add a line{' '}
          <code className="text-brand">Score: 5/5 stars</code> anywhere in the block.
        </p>
        <pre className="text-[11px] text-gray-500 leading-relaxed mt-2 whitespace-pre-wrap">{`https://www.nytimes.com/2026/04/23/...
By Helen Shaw
Full review text…
Score: 4/5 stars
---
https://variety.com/2026/...
By Naveen Kumar
Full review text…`}</pre>
      </div>

      <Field label={`Batch paste (${entries.length} reviews detected)`}>
        <textarea
          value={batchInput}
          onChange={e => setBatchInput(e.target.value)}
          rows={20}
          className={`${inputClass()} font-mono text-xs leading-5 resize-y`}
          disabled={submitting}
          placeholder="Paste all reviews here, separated by --- on its own line…"
        />
      </Field>

      {entries.length > 0 && (
        <div className="text-xs space-y-0.5">
          <div className="text-gray-400">
            <strong className="text-status-open">{validCount} ready</strong> · {invalidCount > 0 && (
              <span className="text-score-tepid">{invalidCount} invalid (URL or text missing)</span>
            )}
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={validCount === 0 || submitting}
        className={[
          'w-full px-4 py-3 font-semibold rounded-lg transition-colors',
          validCount > 0 && !submitting
            ? 'bg-brand text-black hover:bg-brand/90'
            : 'bg-white/5 text-gray-500 cursor-not-allowed',
        ].join(' ')}
      >
        {submitting
          ? `Submitting ${progress.done} of ${progress.total}…`
          : validCount === 0
            ? 'Paste reviews to enable'
            : `Submit all ${validCount} reviews`}
      </button>
    </form>
  );
}

function parseBatch(input: string): BatchEntry[] {
  if (!input.trim()) return [];
  // Split on lines that are 3+ dashes (or 3+ equals) on their own line
  const chunks = input.split(/\n\s*[-=]{3,}\s*\n/);
  return chunks
    .map(chunk => {
      const lines = chunk.split('\n');
      let url = '';
      let scoreInput = '';
      const textLines: string[] = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!url && /^https?:\/\//i.test(line)) {
          url = line;
          continue;
        }
        const scoreMatch = line.match(/^score\s*[:=]\s*(.+)$/i);
        if (scoreMatch) {
          scoreInput = scoreMatch[1].trim();
          continue;
        }
        textLines.push(rawLine);
      }
      return {
        url,
        fullText: textLines.join('\n').trim(),
        scoreInput,
      };
    })
    .filter(e => e.url || e.fullText.trim());
}

function isEntryValid(e: BatchEntry): boolean {
  if (!e.url) return false;
  try {
    new URL(e.url);
  } catch {
    return false;
  }
  return e.fullText.trim().length >= 50;
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
