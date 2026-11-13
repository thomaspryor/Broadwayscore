'use client';

import { useEffect, useRef, useState } from 'react';
import { ScoreBadge, getScoreTier } from '@/components/show-cards';
import { useAuth } from '@/contexts/AuthContext';
import { useScoreCall } from '@/hooks/useScoreCall';
import { isCallableShow, gapSentence, resultStrip, resultSentence, forecastMissSentence, setPendingCall, getPendingCall, clearPendingCall, AUTOSAVE_WINDOW_MS } from '@/lib/score-call';

interface ShowLike { id: string; category?: string; type?: string; status?: string; openingDate?: string | null; previewsStartDate?: string | null; previewDate?: string | null; cancelledBeforeOpening?: boolean }

const ls = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
const localToday = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso?: string | null) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

/** predicted: dashed outline, the same cue /admin/forecasts uses, so a guess never reads as a real score. */
function Tile({ label, score, category, muted, predicted }: { label: string; score: number | null; category?: string; muted?: boolean; predicted?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 min-w-[5.5rem]">
      <div className={predicted ? 'rounded-xl outline outline-2 outline-dashed outline-offset-2 outline-white/30' : undefined} data-predicted={predicted ? 'true' : undefined}>
        <ScoreBadge score={score} size="lg" category={category} />
      </div>
      <span className={`text-center text-[11px] font-semibold uppercase tracking-[0.08em] ${muted ? 'text-fg-muted' : 'text-gray-300'}`}>{label}</span>
    </div>
  );
}

// Module-level so React keeps the subtree (and the slider's drag) across renders.
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 pt-4 border-t border-white/10" data-testid="call-the-score" aria-live="polite">{children}</div>;
}

const lockMsg = (reason: string) => (reason === 'calls_closed' ? 'Predictions closed when opening day began.' : reason === 'not_open' ? 'Predictions open soon for this show.' : reason === 'already_called' ? null : 'Could not save your prediction. Try again.');

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

  if (call) {
    const sentence = gapSentence({ called: call.called_score, forecast: call.forecast as number, lo80: call.lo80 as number, hi80: call.hi80 as number });
    return (
      <Wrap>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-3">Your prediction is locked in</p>
        <div className="flex items-start justify-center gap-5 mb-3 pt-1">
          <Tile label="Your prediction" score={call.called_score} category={show.category} predicted />
          {call.forecast != null && <Tile label="Our forecast" score={call.forecast} category={show.category} muted predicted />}
        </div>
        {sentence && <p className="text-sm text-gray-300 text-center m-0 mb-1">{sentence}</p>}
        {call.forecast == null && <p className="text-sm text-gray-300 text-center m-0 mb-1">We don&apos;t have a forecast for this show.</p>}
        <p className="text-xs text-fg-muted text-center m-0">Reviews come out after opening night{show.openingDate ? `, ${fmtDate(show.openingDate)}` : ''}. Come back to see {call.forecast != null ? 'who was closer' : 'how close you were'}.</p>
      </Wrap>
    );
  }

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
      <p className="text-xs text-fg-muted text-center mt-2 mb-0">Lock in your prediction to see our forecast, when we have one. You&apos;ll need a free account, and a locked prediction can&apos;t be changed.</p>
    </Wrap>
  );
}

/** Result strip once the show has a Critic Score. Only for readers who called. */
export function CallResultStrip({ show, critic }: { show: ShowLike; critic: number }) {
  const { call } = useScoreCall(show.id);
  if (!call) return null;
  const r = resultStrip({ called: call.called_score, forecast: call.forecast, critic });
  if (!r) return null;
  return (
    <div className="mb-4 rounded-lg bg-surface-overlay p-4" data-testid="call-result-strip">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-1">Your prediction</p>
      <p className="text-base font-semibold text-white m-0 mb-3">{resultSentence({ called: call.called_score, r })}</p>
      <div className="flex items-start justify-center gap-2 sm:gap-5 mb-2 pt-1">
        <Tile label="Your prediction" score={call.called_score} category={show.category} predicted />
        {call.forecast != null && <Tile label="Our forecast" score={call.forecast} category={show.category} muted predicted />}
        <Tile label="Critic Score" score={r.critic} category={show.category} />
      </div>
      {forecastMissSentence(r) && <p className="text-xs text-fg-muted text-center m-0">{forecastMissSentence(r)}</p>}
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
