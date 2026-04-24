'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

export default function IngestForm() {
  const [url, setUrl] = useState('');
  const [fullText, setFullText] = useState('');
  const [humanReviewScore, setHumanReviewScore] = useState('');

  const [detected, setDetected] = useState<DetectionResult | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [showIdOverride, setShowIdOverride] = useState('');
  const [criticOverride, setCriticOverride] = useState('');
  const [publishDateOverride, setPublishDateOverride] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);
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
  const effectiveCritic = criticOverride.trim() || detected?.criticName || '';
  const effectivePublishDate = publishDateOverride.trim() || detected?.publishDate || '';
  const effectiveOutlet = detected?.outletId || '';

  const readyToSubmit = Boolean(
    url.trim().length > 0 &&
      fullText.trim().length >= 50 &&
      effectiveShowId &&
      effectiveCritic &&
      effectiveOutlet,
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!readyToSubmit || submitting) return;

    setSubmitting(true);
    setResult(null);
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
          humanReviewScore: humanReviewScore ? Number(humanReviewScore) : null,
          forceClearStale,
        }),
      });
      const json = (await res.json()) as IngestResponse;
      setResult(json);
      if (json.success) {
        setUrl('');
        setFullText('');
        setHumanReviewScore('');
        setShowIdOverride('');
        setCriticOverride('');
        setPublishDateOverride('');
        setDetected(null);
        setForceClearStale(false);
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field label="Review URL" hint="Outlet + publish date auto-detected">
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          autoComplete="off"
          className={inputClass()}
          disabled={submitting}
          placeholder="https://www.nytimes.com/2026/..."
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>

      <Field label="Full text" hint="Paste the review body. Critic + show auto-detected.">
        <textarea
          value={fullText}
          onChange={e => setFullText(e.target.value)}
          rows={12}
          className={`${inputClass()} font-mono text-xs leading-5 resize-y`}
          disabled={submitting}
          placeholder="Paste the full review text here…"
        />
        <div className="text-xs text-gray-500 mt-1">
          {fullText.length > 0 && `${fullText.length.toLocaleString()} chars`}
        </div>
      </Field>

      <Field
        label="Score (optional)"
        hint="Only fill if explicitly stated in the review (stars, thumbs, etc.). Otherwise the LLM pipeline scores it."
      >
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          value={humanReviewScore}
          onChange={e => setHumanReviewScore(e.target.value)}
          className={inputClass()}
          disabled={submitting}
          placeholder="1–100"
          inputMode="numeric"
        />
      </Field>

      <DetectedPreview
        detected={detected}
        loading={detectLoading}
        showIdOverride={showIdOverride}
        setShowIdOverride={setShowIdOverride}
        criticOverride={criticOverride}
        setCriticOverride={setCriticOverride}
        publishDateOverride={publishDateOverride}
        setPublishDateOverride={setPublishDateOverride}
        effectiveShowId={effectiveShowId}
        effectiveCritic={effectiveCritic}
        effectivePublishDate={effectivePublishDate}
        disabled={submitting}
      />

      <label className="flex items-start gap-2 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={forceClearStale}
          onChange={e => setForceClearStale(e.target.checked)}
          disabled={submitting}
          className="accent-brand mt-0.5"
        />
        <span>
          Force-clear stale wrongProduction/wrongShow flag on existing file (only if existing file
          is for a different production)
        </span>
      </label>

      <button
        type="submit"
        disabled={!readyToSubmit || submitting}
        className="w-full px-4 py-3 bg-brand text-black font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
      >
        {submitting ? 'Ingesting…' : 'Ingest review'}
      </button>

      {result && <Result result={result} />}
    </form>
  );
}

function DetectedPreview({
  detected,
  loading,
  showIdOverride,
  setShowIdOverride,
  criticOverride,
  setCriticOverride,
  publishDateOverride,
  setPublishDateOverride,
  effectiveShowId,
  effectiveCritic,
  effectivePublishDate,
  disabled,
}: {
  detected: DetectionResult | null;
  loading: boolean;
  showIdOverride: string;
  setShowIdOverride: (v: string) => void;
  criticOverride: string;
  setCriticOverride: (v: string) => void;
  publishDateOverride: string;
  setPublishDateOverride: (v: string) => void;
  effectiveShowId: string;
  effectiveCritic: string;
  effectivePublishDate: string;
  disabled: boolean;
}) {
  if (!detected && !loading) {
    return (
      <div className="rounded-lg border border-white/5 bg-surface-raised/50 p-4 text-xs text-gray-500">
        Detected fields appear here once you paste a URL and text.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-surface-raised p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Detected</h3>
        {loading && <span className="text-xs text-gray-500">Detecting…</span>}
      </div>

      <DetectedRow
        label="Outlet"
        value={
          detected
            ? detected.outletDisplayName
              ? `${detected.outletDisplayName} (${detected.outletId})`
              : null
            : null
        }
        editable={false}
      />

      <DetectedRow
        label="Show"
        value={
          detected
            ? detected.showTitle
              ? `${detected.showTitle} (${detected.showId})`
              : null
            : null
        }
        editable
        override={showIdOverride}
        setOverride={setShowIdOverride}
        placeholder="e.g. the-rocky-horror-show-2026"
        effectiveValue={effectiveShowId}
        disabled={disabled}
        candidates={detected?.showCandidates}
        onPickCandidate={id => setShowIdOverride(id)}
        confidence={detected?.showConfidence}
      />

      <DetectedRow
        label="Critic"
        value={detected?.criticName ?? null}
        editable
        override={criticOverride}
        setOverride={setCriticOverride}
        placeholder="e.g. Helen Shaw"
        effectiveValue={effectiveCritic}
        disabled={disabled}
      />

      <DetectedRow
        label="Publish date"
        value={detected?.publishDate ?? null}
        editable
        override={publishDateOverride}
        setOverride={setPublishDateOverride}
        placeholder="YYYY-MM-DD"
        effectiveValue={effectivePublishDate}
        disabled={disabled}
      />

      {detected && detected.warnings.length > 0 && (
        <ul className="text-xs text-score-tepid space-y-0.5 pt-1">
          {detected.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetectedRow({
  label,
  value,
  editable,
  override,
  setOverride,
  placeholder,
  effectiveValue,
  disabled,
  candidates,
  onPickCandidate,
  confidence,
}: {
  label: string;
  value: string | null;
  editable: boolean;
  override?: string;
  setOverride?: (v: string) => void;
  placeholder?: string;
  effectiveValue?: string;
  disabled?: boolean;
  candidates?: Array<{ id: string; title: string; openingDate: string | null }>;
  onPickCandidate?: (id: string) => void;
  confidence?: 'high' | 'medium' | 'low' | null;
}) {
  const isEditing = editable && ((override && override.length > 0) || !value);

  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
        {confidence && value && (
          <span
            className={`text-[10px] uppercase tracking-wider ${
              confidence === 'high' ? 'text-status-open' : 'text-score-tepid'
            }`}
          >
            {confidence}
          </span>
        )}
      </div>
      {!isEditing && value ? (
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-gray-200">{value}</span>
          {editable && setOverride && (
            <button
              type="button"
              onClick={() => setOverride(value.split(' ')[0])}
              disabled={disabled}
              className="text-[11px] text-brand underline hover:no-underline"
            >
              edit
            </button>
          )}
        </div>
      ) : editable && setOverride ? (
        <div className="space-y-1.5 mt-0.5">
          <input
            type="text"
            value={override ?? ''}
            onChange={e => setOverride(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="off"
            className={`${inputClass()} text-sm`}
          />
          {effectiveValue && effectiveValue !== value && (
            <div className="text-[11px] text-gray-500">Using: {effectiveValue}</div>
          )}
        </div>
      ) : (
        <div className="text-gray-500 text-xs mt-0.5">—</div>
      )}
      {candidates && candidates.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {candidates.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPickCandidate?.(c.id)}
              disabled={disabled}
              className="text-[11px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300"
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-200 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function Result({ result }: { result: IngestResponse }) {
  if (result.success) {
    return (
      <div className="rounded-lg border border-status-open/40 bg-status-open/10 p-4 text-sm">
        <p className="font-semibold text-status-open">✓ Ingested</p>
        <dl className="mt-2 space-y-1 text-gray-200 text-xs font-mono">
          <Row k="Show" v={result.showId} />
          <Row k="Outlet" v={result.outletId} />
          <Row k="Critic" v={result.criticName} />
          <Row k="Date" v={result.publishDate || undefined} />
          <Row k="Path" v={result.path} />
          <Row k="Commit" v={result.commitSha?.slice(0, 10)} />
        </dl>
        {result.workflowRunUrl && (
          <a
            href={result.workflowRunUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-brand underline hover:no-underline text-xs"
          >
            → Rebuild-fast workflow runs
          </a>
        )}
        {result.warning && <p className="mt-2 text-xs text-score-tepid">⚠ {result.warning}</p>}
        {result.detectionWarnings && result.detectionWarnings.length > 0 && (
          <ul className="mt-2 text-xs text-score-tepid space-y-0.5">
            {result.detectionWarnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-score-skip/40 bg-score-skip/10 p-4 text-sm">
      <p className="font-semibold text-score-skip">✕ Failed</p>
      <p className="mt-2 text-gray-200 text-xs whitespace-pre-wrap">{result.error}</p>
      {result.detectionWarnings && result.detectionWarnings.length > 0 && (
        <ul className="mt-2 text-xs text-gray-400 space-y-0.5">
          {result.detectionWarnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {result.collisionDetail !== undefined && result.collisionDetail !== null ? (
        <details className="mt-2">
          <summary className="text-xs text-gray-400 cursor-pointer">Collision detail</summary>
          <pre className="mt-1 text-[11px] text-gray-400 whitespace-pre-wrap break-all">
            {JSON.stringify(result.collisionDetail, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div className="flex gap-2">
      <dt className="text-gray-500 w-16 shrink-0">{k}</dt>
      <dd className="break-all">{v}</dd>
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
