'use client';

import { useEffect, useState } from 'react';
import { ScoreBadge, getScoreTier } from '@/components/show-cards';
import { useAuth } from '@/contexts/AuthContext';
import { useScoreCall } from '@/hooks/useScoreCall';
import { isCallableShow, gapSentence, resultStrip } from '@/lib/score-call';

interface ShowLike { id: string; category?: string; type?: string; status?: string; openingDate?: string | null; previewsStartDate?: string | null; previewDate?: string | null; cancelledBeforeOpening?: boolean }

const localToday = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso?: string | null) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

function Tile({ label, score, category, muted }: { label: string; score: number | null; category?: string; muted?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1.5 min-w-[5.5rem]">
      {score == null ? <div className="score-badge w-16 h-16 sm:w-20 sm:h-20 text-3xl rounded-xl score-none font-bold text-gray-400 flex items-center justify-center">?</div> : <ScoreBadge score={score} size="lg" category={category} />}
      <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${muted ? 'text-fg-muted' : 'text-gray-300'}`}>{label}</span>
    </div>
  );
}

// Module-level so React keeps the subtree (and the slider's drag) across renders.
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 pt-4 border-t border-white/10" data-testid="call-the-score">{children}</div>;
}

/** Pending-state card: sign in, pick 0-100, lock, reveal. Renders nothing for shows a reader cannot call. */
export default function CallTheScore({ show }: { show: ShowLike }) {
  const { showSignIn } = useAuth();
  const { signedIn, loaded, call, lock } = useScoreCall(show.id);
  const [value, setValue] = useState(70);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [callable, setCallable] = useState(false);
  useEffect(() => { setCallable(isCallableShow(show as never, localToday())); }, [show]);
  if (!callable) return null;
  const tier = getScoreTier(value, show.category);

  const onLock = async () => {
    setBusy(true); setMsg(null);
    const r = await lock(value);
    setBusy(false);
    if (!r.ok) setMsg(r.reason === 'calls_closed' ? 'Calls closed when the show opened.' : r.reason === 'not_open' ? 'Calls open soon for this show.' : r.reason === 'already_called' ? null : 'Could not lock your call. Try again.');
  };

  if (signedIn && !loaded) return <Wrap><div className="h-24" aria-hidden /></Wrap>;

  if (call) {
    const sentence = gapSentence({ called: call.called_score, forecast: call.forecast as number, lo80: call.lo80 as number, hi80: call.hi80 as number });
    return (
      <Wrap>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-3">Your call is in</p>
        <div className="flex items-start justify-center gap-4 mb-3">
          <Tile label="Your call" score={call.called_score} category={show.category} />
          {call.forecast != null && <Tile label="Our forecast" score={call.forecast} category={show.category} muted />}
        </div>
        {sentence && <p className="text-sm text-gray-300 text-center m-0 mb-1">{sentence}</p>}
        <p className="text-xs text-fg-muted text-center m-0">Both get scored when reviews land{show.openingDate ? ` on ${fmtDate(show.openingDate)}` : ''}.</p>
      </Wrap>
    );
  }

  if (!signedIn) {
    return (
      <Wrap>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-3">Call the score</p>
        <div className="flex items-center gap-4">
          <div className="score-badge w-16 h-16 sm:w-20 sm:h-20 text-3xl rounded-xl score-none font-bold text-gray-400 flex items-center justify-center border border-dashed border-white/20" aria-hidden>?</div>
          <p className="text-sm text-gray-300 m-0">Guess what the critics will give it, then see what we are predicting.</p>
        </div>
        <button type="button" className="btn-primary w-full mt-4" onClick={() => showSignIn('generic', 'call_the_score')}>Sign in to call the score</button>
        <p className="text-xs text-fg-muted text-center mt-2 mb-0">Free. Signed-in readers only, one call per show.</p>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-1">Call the score</p>
      <h3 className="text-base font-semibold text-white m-0 mb-3">What will the critics give it?</h3>
      <div className="flex items-center gap-4 mb-3">
        <ScoreBadge score={value} size="lg" category={show.category} />
        <span className="text-sm font-semibold text-gray-200" aria-live="polite">{tier?.label}</span>
      </div>
      <input type="range" min={0} max={100} step={1} value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label="Your score call, 0 to 100" className="w-full accent-brand" />
      <button type="button" className="btn-primary w-full mt-4" disabled={busy} onClick={onLock}>{busy ? 'Locking in…' : 'Lock in and see our forecast'}</button>
      {msg && <p className="text-xs text-score-skip text-center mt-2 mb-0" role="alert">{msg}</p>}
      <p className="text-xs text-fg-muted text-center mt-2 mb-0">Want to see what we&apos;re predicting? Make your guess to reveal it. One call per show, final once you lock it in.</p>
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
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-1">Your call</p>
      <p className="text-base font-semibold text-white m-0 mb-3">Off by {r.off}.{r.beatForecast ? ' You beat our forecast.' : ''}</p>
      <div className="flex items-start justify-center gap-4 mb-2">
        <Tile label="You" score={call.called_score} category={show.category} />
        {call.forecast != null && <Tile label="Our forecast" score={call.forecast} category={show.category} muted />}
        <Tile label="Critics" score={r.critic} category={show.category} />
      </div>
      {r.forecastMiss != null && <p className="text-xs text-fg-muted text-center m-0">Our forecast (when you called) was off by {r.forecastMiss}.</p>}
    </div>
  );
}

/** Hero "Awaiting reviews" link: anchor to the card, or "You called N". */
export function CallTheScoreHeroLink({ show }: { show: ShowLike }) {
  const { call } = useScoreCall(show.id);
  const [callable, setCallable] = useState(false);
  useEffect(() => { setCallable(isCallableShow(show as never, localToday())); }, [show]);
  if (!callable) return null;
  return <a href="#critic-reviews" className="inline-block mt-1.5 text-xs font-semibold text-brand hover:text-brand-hover transition-colors" data-testid="call-the-score-link">{call ? `You called ${call.called_score}` : 'Call the score'}</a>;
}
