'use client';

import { useEffect, useRef, useState } from 'react';
import { ScoreBadge, getScoreTier } from '@/components/show-cards';
import { useAuth } from '@/contexts/AuthContext';
import { useScoreCall, useScoreCallReaders } from '@/hooks/useScoreCall';
import { isCallableShow, gapSentence, readersSentence, rangeCaption, readersCaption, smallPrint, readersMissSentence, FIRST_READER_LINE, resultStrip, resultSentence, forecastMissSentence, setPendingCall, getPendingCall, clearPendingCall, AUTOSAVE_WINDOW_MS } from '@/lib/score-call';

interface ShowLike { id: string; category?: string; type?: string; status?: string; openingDate?: string | null; previewsStartDate?: string | null; previewDate?: string | null; cancelledBeforeOpening?: boolean }

const ls = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
const localToday = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso?: string | null) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

/** predicted: dashed outline, the same cue /admin/forecasts uses, so a guess never reads as a real score. */
function Tile({ label, score, category, muted, predicted, caption }: { label: string; score: number | null; category?: string; muted?: boolean; predicted?: boolean; caption?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 w-[5.25rem] sm:w-auto sm:min-w-[5.5rem]">
      <div className={predicted ? 'rounded-xl outline outline-2 outline-dashed outline-offset-2 outline-white/30' : undefined} data-predicted={predicted ? 'true' : undefined}>
        <ScoreBadge score={score} size="lg" category={category} />
      </div>
      <span className={`text-center text-[11px] font-semibold uppercase tracking-[0.08em] ${muted ? 'text-fg-muted' : 'text-gray-300'}`}>{label}</span>
      {caption && <span className="-mt-1 text-center text-[11px] leading-tight text-fg-muted">{caption}</span>}
    </div>
  );
}

/** "likely 63 to 77": the numbers a touch brighter than the word. */
function RangeCaption({ lo50, hi50 }: { lo50?: number | null; hi50?: number | null }) {
  const c = rangeCaption({ lo50: lo50 as number, hi50: hi50 as number });
  return c ? <>{c.word} <span className="text-gray-300 whitespace-nowrap">{c.nums}</span></> : null;
}

// Module-level so React keeps the subtree (and the slider's drag) across renders.
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 pt-4 border-t border-white/10" data-testid="call-the-score" aria-live="polite">{children}</div>;
}

const lockMsg = (reason: string) => (reason === 'calls_closed' ? 'Predictions closed when opening day began.' : reason === 'not_open' ? 'Predictions open soon for this show.' : reason === 'already_called' ? null : 'Could not save your prediction. Try again.');

/** Locked state. Readers load after the lock; sentences wait for them so the text does not change under the reader. */
function LockedCard({ show, call }: { show: ShowLike; call: NonNullable<ReturnType<typeof useScoreCall>['call']> }) {
  const { ready, readers, failed } = useScoreCallReaders(show.id, true);
  const hasF = call.forecast != null;
  const rng = rangeCaption({ lo50: call.lo50 as number, hi50: call.hi50 as number });
  const sentence = readers
    ? readersSentence({ called: call.called_score, forecast: call.forecast as number, readersAvg: readers.avg, readersN: readers.n })
    : gapSentence({ called: call.called_score, forecast: call.forecast as number, lo50: call.lo50 as number, hi50: call.hi50 as number });
  return (
    <Wrap>
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-3">Prediction locked in</p>
      <div className={`flex flex-wrap items-start justify-center gap-y-3 mb-3 pt-1 ${readers && hasF ? 'gap-x-2 sm:gap-x-4' : 'gap-x-4'}`}>
        <Tile label="Your prediction" score={call.called_score} category={show.category} predicted />
        {readers && <Tile label="Readers" score={readers.avg} category={show.category} muted predicted caption={readersCaption(readers.n)} />}
        {hasF && <Tile label="Our forecast" score={call.forecast} category={show.category} muted predicted caption={rng ? <RangeCaption lo50={call.lo50} hi50={call.hi50} /> : undefined} />}
      </div>
      {ready && sentence && <p className="text-sm text-gray-300 text-center m-0 mb-1">{sentence}</p>}
      {ready && !hasF && !readers && <p className="text-sm text-gray-300 text-center m-0 mb-1">We don&apos;t have a forecast for this show.</p>}
      {ready && !failed && !readers && <p className="text-sm text-gray-300 text-center m-0 mb-1">{FIRST_READER_LINE}</p>}
      {ready && <p className="text-xs text-fg-muted text-center m-0">{smallPrint({ hasForecast: hasF, hasRange: !!rng, hasReaders: !!readers, dateText: fmtDate(show.openingDate) })}</p>}
    </Wrap>
  );
}

/** Pending-state card: pick 0-100 (signed out is fine), save it with an account, then see the forecast. Renders nothing for shows a reader cannot predict. */
export default function CallTheScore({ show }: { show: ShowLike }) {
  const { showSignIn } = useAuth();
  const { signedIn, loaded, call, lock, loadError, retry } = useScoreCall(show.id);
  const [value, setValue] = useState(70);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saveAsk, setSaveAsk] = useState(false);
  const [callable, setCallable] = useState(false);
  const autoRef = useRef(false);
  const tapRef = useRef(false);
  useEffect(() => { setCallable(isCallableShow(show as never, localToday())); }, [show]);
  // Back from sign-up (or a fresh visit): restore the number they picked.
  useEffect(() => {
    const p = getPendingCall(show.id, ls());
    if (p != null) { setValue(p); setSaveAsk(true); }
  }, [show.id]);
  // Once signed in and nothing is saved yet, save the waiting number automatically.
  useEffect(() => {
    if (!callable || !signedIn || !loaded || loadError || call || autoRef.current) return;
    const p = getPendingCall(show.id, ls(), Date.now(), AUTOSAVE_WINDOW_MS);
    if (p == null) return;
    autoRef.current = true;
    setBusy(true); setValue(p);
    lock(p).then((r) => {
      setBusy(false);
      if (r.ok || r.reason === 'already_called' || r.reason === 'calls_closed') clearPendingCall(show.id, ls());
      else autoRef.current = false;
      if (!r.ok) setMsg(lockMsg(r.reason));
    });
  }, [callable, signedIn, loaded, loadError, call, show.id, lock]);
  useEffect(() => { if (call) clearPendingCall(show.id, ls()); }, [call, show.id]);
  if (!callable) return null;
  const tier = getScoreTier(value, show.category);

  const onLock = async () => {
    setMsg(null);
    if (!signedIn) {
      // Only the number is stored. The forecast never reaches a signed-out browser.
      setPendingCall(show.id, value, ls());
      setSaveAsk(true);
      showSignIn('prediction', 'predict_the_score');
      return;
    }
    if (tapRef.current) return;
    tapRef.current = true; setBusy(true);
    const r = await lock(value);
    tapRef.current = false; setBusy(false);
    if (!r.ok) setMsg(lockMsg(r.reason));
  };

  if (signedIn && !loaded) return <Wrap><div className="h-24" aria-hidden /></Wrap>;

  // A failed fetch is not "no prediction yet": never offer the slider, or a reader could pick again for a show they already called.
  if (signedIn && loadError) {
    return (
      <Wrap>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-1">Predict the score</p>
        <p className="text-sm text-gray-200 m-0 mb-3" role="alert">We couldn&apos;t load your prediction. Check your connection and try again.</p>
        <button type="button" className="btn-secondary w-full min-h-[44px]" onClick={retry} data-testid="call-retry">Try again</button>
      </Wrap>
    );
  }

  if (call) return <LockedCard show={show} call={call} />;

  return (
    <Wrap>
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-1">Predict the score</p>
      <h3 className="text-base font-semibold text-white m-0 mb-3">What will the critics give it?</h3>
      <div className="flex items-center gap-4 mb-3">
        <ScoreBadge score={value} size="lg" category={show.category} />
        <span className="text-sm font-semibold text-gray-200" aria-live="polite">{tier?.label}</span>
      </div>
      <input type="range" min={0} max={100} step={1} value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label="Your score prediction, 0 to 100" aria-valuetext={`${value}, ${tier?.label ?? ''}`} className="w-full accent-brand" />
      <button type="button" className="btn-primary w-full mt-4" disabled={busy} onClick={onLock}>{busy ? 'Saving your prediction…' : 'Lock in my prediction'}</button>
      {!signedIn && saveAsk && <p className="text-sm text-gray-200 text-center mt-2 mb-0" data-testid="save-prompt">Save your prediction: create a free account or sign in.</p>}
      {msg && <p className="text-xs text-score-skip text-center mt-2 mb-0" role="alert">{msg}</p>}
      <p className="text-xs text-fg-muted text-center mt-2 mb-0">Lock in your prediction to see our forecast, if we have one. You&apos;ll need a free account, and a locked prediction can&apos;t be changed.</p>
    </Wrap>
  );
}

/** Result strip once the show has a Critic Score. Only for readers who called. */
export function CallResultStrip({ show, critic }: { show: ShowLike; critic: number }) {
  const { call } = useScoreCall(show.id);
  const { readers } = useScoreCallReaders(show.id, !!call);
  if (!call) return null;
  const r = resultStrip({ called: call.called_score, forecast: call.forecast, critic });
  if (!r) return null;
  const footer = [forecastMissSentence(r), readers ? readersMissSentence(readers.avg, critic, readers.n) : null].filter(Boolean).join(' ');
  return (
    <div className="mb-4 rounded-lg bg-surface-overlay p-4" data-testid="call-result-strip">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-1">How your prediction did</p>
      <p className="text-base font-semibold text-white m-0 mb-3">{resultSentence({ r })}</p>
      <div className="flex flex-wrap items-start justify-center gap-x-2 gap-y-3 sm:gap-x-5 mb-2 pt-1">
        <Tile label="Your prediction" score={call.called_score} category={show.category} predicted />
        {readers && <Tile label="Readers" score={readers.avg} category={show.category} muted predicted caption={readersCaption(readers.n)} />}
        {call.forecast != null && <Tile label="Our forecast" score={call.forecast} category={show.category} muted predicted />}
        <Tile label="Critic Score" score={r.critic} category={show.category} />
      </div>
      {footer && <p className="text-xs text-fg-muted text-center m-0">{footer}</p>}
    </div>
  );
}

/** Hero "Awaiting reviews" link: anchor to the card, or "You predicted N". */
export function CallTheScoreHeroLink({ show }: { show: ShowLike }) {
  const { call } = useScoreCall(show.id);
  const [callable, setCallable] = useState(false);
  useEffect(() => { setCallable(isCallableShow(show as never, localToday())); }, [show]);
  if (!callable) return null;
  return <a href="#critic-reviews" className="inline-flex items-center min-h-[44px] mt-0.5 text-xs font-semibold text-brand hover:text-brand-hover transition-colors" data-testid="call-the-score-link">{call ? `You predicted ${call.called_score}` : 'Predict the score'}</a>;
}
