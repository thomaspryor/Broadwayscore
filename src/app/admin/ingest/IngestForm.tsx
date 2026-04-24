'use client';

import { useState } from 'react';

interface IngestResponse {
  success: boolean;
  path?: string;
  outletId?: string;
  filename?: string;
  commitSha?: string;
  workflowRunUrl?: string;
  collisionDetail?: unknown;
  error?: string;
  warning?: string;
}

type FieldErrors = Partial<Record<'showId' | 'url' | 'fullText' | 'criticName' | 'humanReviewScore' | 'publishDate', string>>;

export default function IngestForm() {
  const [showId, setShowId] = useState('');
  const [url, setUrl] = useState('');
  const [fullText, setFullText] = useState('');
  const [criticName, setCriticName] = useState('');
  const [humanReviewScore, setHumanReviewScore] = useState('');
  const [publishDate, setPublishDate] = useState('');
  const [forceClearStale, setForceClearStale] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!showId.trim()) e.showId = 'Required';
    if (!url.trim()) e.url = 'Required';
    else {
      try {
        new URL(url);
      } catch {
        e.url = 'Not a valid URL';
      }
    }
    if (!fullText.trim()) e.fullText = 'Required';
    else if (fullText.trim().length < 50) e.fullText = 'Must be at least 50 characters';
    if (!criticName.trim()) e.criticName = 'Required';
    if (humanReviewScore) {
      const n = Number(humanReviewScore);
      if (!Number.isFinite(n) || n < 1 || n > 100) e.humanReviewScore = 'Must be 1-100';
    }
    if (publishDate && !/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) {
      e.publishDate = 'Use YYYY-MM-DD';
    }
    return e;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ve = validate();
    setErrors(ve);
    if (Object.keys(ve).length > 0) return;

    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/ingest-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showId: showId.trim(),
          url: url.trim(),
          fullText: fullText.trim(),
          criticName: criticName.trim(),
          humanReviewScore: humanReviewScore ? Number(humanReviewScore) : null,
          publishDate: publishDate || null,
          forceClearStale,
        }),
      });
      const json = (await res.json()) as IngestResponse;
      setResult(json);
      if (json.success) {
        setShowId('');
        setUrl('');
        setFullText('');
        setCriticName('');
        setHumanReviewScore('');
        setPublishDate('');
        setForceClearStale(false);
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Show ID" error={errors.showId} hint="e.g. beaches-2026">
        <input
          type="text"
          value={showId}
          onChange={e => setShowId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={inputClass(!!errors.showId)}
          disabled={submitting}
        />
      </Field>

      <Field label="Review URL" error={errors.url} hint="Outlet is resolved automatically from the domain">
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          autoComplete="off"
          className={inputClass(!!errors.url)}
          disabled={submitting}
          placeholder="https://www.nytimes.com/2026/..."
        />
      </Field>

      <Field label="Critic name" error={errors.criticName} hint="Full name as published">
        <input
          type="text"
          value={criticName}
          onChange={e => setCriticName(e.target.value)}
          autoComplete="off"
          className={inputClass(!!errors.criticName)}
          disabled={submitting}
          placeholder="Jesse Green"
        />
      </Field>

      <Field label="Full text" error={errors.fullText} hint="Paste the full review body">
        <textarea
          value={fullText}
          onChange={e => setFullText(e.target.value)}
          rows={10}
          className={`${inputClass(!!errors.fullText)} font-mono text-xs leading-5 resize-y`}
          disabled={submitting}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Score (1-100)" error={errors.humanReviewScore} hint="Leave blank for LLM score">
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={humanReviewScore}
            onChange={e => setHumanReviewScore(e.target.value)}
            className={inputClass(!!errors.humanReviewScore)}
            disabled={submitting}
          />
        </Field>
        <Field label="Publish date" error={errors.publishDate} hint="YYYY-MM-DD">
          <input
            type="text"
            value={publishDate}
            onChange={e => setPublishDate(e.target.value)}
            autoComplete="off"
            placeholder="2026-04-22"
            className={inputClass(!!errors.publishDate)}
            disabled={submitting}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={forceClearStale}
          onChange={e => setForceClearStale(e.target.checked)}
          disabled={submitting}
          className="accent-brand"
        />
        Force-clear stale wrongProduction/wrongShow flag on existing file (use only when existing file is for a different production)
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2.5 bg-brand text-black font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
      >
        {submitting ? 'Ingesting…' : 'Ingest review'}
      </button>

      {result && <Result result={result} />}
    </form>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-200 mb-1">{label}</label>
      {children}
      {error ? (
        <p className="text-xs text-score-skip mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-gray-500 mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

function Result({ result }: { result: IngestResponse }) {
  if (result.success) {
    return (
      <div className="rounded-lg border border-status-open/40 bg-status-open/10 p-4 text-sm">
        <p className="font-semibold text-status-open">✓ Ingested</p>
        <dl className="mt-2 space-y-1 text-gray-200 text-xs font-mono">
          <Row k="Path" v={result.path} />
          <Row k="Outlet" v={result.outletId} />
          <Row k="Commit" v={result.commitSha?.slice(0, 10)} />
          {result.workflowRunUrl && (
            <div className="pt-2">
              <a
                href={result.workflowRunUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline hover:no-underline"
              >
                → Rebuild-fast workflow runs
              </a>
            </div>
          )}
        </dl>
        {result.warning && <p className="mt-2 text-xs text-score-tepid">⚠ {result.warning}</p>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-score-skip/40 bg-score-skip/10 p-4 text-sm">
      <p className="font-semibold text-score-skip">✕ Failed</p>
      <p className="mt-2 text-gray-200 text-xs whitespace-pre-wrap">{result.error}</p>
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

function inputClass(hasError: boolean): string {
  return [
    'w-full px-3 py-2 text-sm bg-surface-raised border rounded-lg text-white',
    'focus:outline-none focus:ring-2',
    hasError
      ? 'border-score-skip/60 focus:ring-score-skip/50 focus:border-score-skip/50'
      : 'border-white/10 focus:ring-brand/50 focus:border-brand/50',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' ');
}
