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

export default function IngestForm() {
  const [url, setUrl] = useState('');
  const [fullText, setFullText] = useState('');
  // Score is a free-form text input — accepts "5/5 stars", "★★★★", "B+", "90/100", etc.
  // We compute the /100 value live for display, and the server stores both the raw
  // string (originalScore) and the parsed integer (humanReviewScore).
  const [scoreInput, setScoreInput] = useState('');

  const [detected, setDetected] = useState<DetectionResult | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [showIdOverride, setShowIdOverride] = useState('');
  const [criticOverride, setCriticOverride] = useState('');
  const [publishDateOverride, setPublishDateOverride] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [forceClearStale, setForceClearStale] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  // Live score parsing for display.
  const parsedScore = useMemo(() => {
    if (!scoreInput.trim()) return null;
    return parseScore(scoreInput);
  }, [scoreInput]);

  // Tell the user exactly what's missing if they can't submit.
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
          // Send the raw rating string. Server parses + stores both originalScore
          // and humanReviewScore (the /100 value).
          originalScore: scoreInput.trim() || null,
          forceClearStale,
        }),
      });
      const json = (await res.json()) as IngestResponse;
      setResult(json);
      if (json.success) {
        setUrl('');
        setFullText('');
        setScoreInput('');
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

  const buttonLabel = submitting
    ? 'Submitting…'
    : !readyToSubmit
      ? `Need: ${missingPieces[0]}`
      : 'Submit review';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ─── Step 1: URL ─── */}
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

      {/* ─── Step 2: Full text ─── */}
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

      {/* ─── Detected box (always visible — shows progress as user pastes) ─── */}
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

      {/* ─── Optional score (with live conversion) ─── */}
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

      {/* ─── Advanced (collapsed by default) ─── */}
      <details
        open={advancedOpen}
        onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
        className="rounded-lg border border-white/5 bg-surface-raised/40"
      >
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

      {/* ─── Submit button ─── */}
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

      {result && <Result result={result} />}
    </form>
  );
}

// ─── Detected section ──────────────────────────────────────────────

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

      {/* Outlet — never editable; we only accept registered outlets */}
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

      {/* Show */}
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

      {/* Critic — when missing, surface the input directly with a clear ask */}
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

      {/* Publish date */}
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
  // When the field is missing AND marked autoExpand, force the input visible.
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

      {/* Display + edit affordance */}
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

      {/* Inline editor */}
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

      {/* Missing — not auto-expanded, not optional */}
      {!inputVisible && !value && !editable && missingHint && (
        <div className="text-xs text-score-skip">⚠ {missingHint}</div>
      )}
      {!inputVisible && !value && optional && !override?.length && (
        <div className="text-xs text-gray-500">— {missingHint || 'not detected (optional)'}</div>
      )}

      {/* Candidate chips for ambiguous show match */}
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

// ─── Misc helpers ──────────────────────────────────────────────────

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

function Result({ result }: { result: IngestResponse }) {
  if (result.success) {
    return (
      <div className="rounded-lg border border-status-open/40 bg-status-open/10 p-4 text-sm">
        <p className="font-semibold text-status-open">✓ Saved</p>
        <p className="mt-1 text-xs text-gray-400">
          The review will appear on the show page after the next rebuild + deploy (~10 min).
        </p>
        <dl className="mt-3 space-y-1 text-gray-200 text-xs font-mono">
          <Row k="Show" v={result.showId} />
          <Row k="Outlet" v={result.outletId} />
          <Row k="Critic" v={result.criticName} />
          <Row k="Date" v={result.publishDate || undefined} />
          <Row k="Commit" v={result.commitSha?.slice(0, 10)} />
        </dl>
        {result.workflowRunUrl && (
          <a
            href={result.workflowRunUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-brand underline hover:no-underline text-xs"
          >
            → Watch the rebuild
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
      <p className="font-semibold text-score-skip">✕ Couldn&apos;t save</p>
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
          <summary className="text-xs text-gray-400 cursor-pointer">Conflict details</summary>
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
