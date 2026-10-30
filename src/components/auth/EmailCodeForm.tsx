'use client';

import { useEffect, useRef, useState } from 'react';

/** Supabase mailer_otp_length (scripts/apply-supabase-email-auth.mjs). */
export const EMAIL_CODE_LENGTH = 6;

export type EmailAuthResult = { error?: string } | void;

interface EmailCodeFormProps {
  /** Emails a sign-in code to the address. */
  onSendCode: (email: string) => Promise<EmailAuthResult>;
  /** Signs in with the code from that email. */
  onVerifyCode: (email: string, code: string) => Promise<EmailAuthResult>;
  /** Back to the Google/Apple buttons. */
  onBack: () => void;
  disabled?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email sign-in with a one-time code (BRO-6575): no password. Step one asks
 * for the address, step two for the 6-digit code from the email. The email
 * carries no link (supabase/templates/sign-in-code.html says why).
 */
export default function EmailCodeForm({ onSendCode, onVerifyCode, onBack, disabled = false }: EmailCodeFormProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // State updates lag a tick, so autofill firing onChange twice could verify
  // twice and spend the code; a ref blocks the second call at once.
  const verifying = useRef(false);

  useEffect(() => {
    (step === 'email' ? emailRef : codeRef).current?.focus();
  }, [step]);

  // An input disabled while checking loses focus; give it back after an error.
  useEffect(() => {
    if (!busy && error) (step === 'email' ? emailRef : codeRef).current?.select();
  }, [busy, error, step]);

  const send = async (resend = false) => {
    const address = email.trim();
    if (!EMAIL_RE.test(address)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await onSendCode(address);
    setBusy(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    setCode('');
    setStep('code');
    if (resend) setNotice('We sent a new code.');
  };

  const verify = async (value: string) => {
    if (value.length !== EMAIL_CODE_LENGTH || verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await onVerifyCode(email.trim(), value);
    // On success the auth listener closes the modal; keep the spinner until then.
    if (result?.error) {
      verifying.current = false;
      setBusy(false);
      setError(result.error);
    }
  };

  const inputClass = 'w-full px-4 py-3 bg-surface-overlay text-white text-sm rounded-lg border border-white/10 placeholder-gray-500 focus:outline-none focus:border-white/40 disabled:opacity-50';
  const primaryClass = 'w-full px-4 py-3 bg-white text-gray-800 font-semibold text-sm rounded-lg hover:bg-gray-100 disabled:opacity-50 transition-colors';
  const linkClass = 'text-sm text-gray-400 underline hover:text-gray-200 disabled:opacity-50';

  if (step === 'email') {
    return (
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <label htmlFor="signin-email" className="sr-only">Email address</label>
        <input
          ref={emailRef}
          id="signin-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy || disabled}
          className={inputClass}
        />
        <button type="submit" disabled={busy || disabled} className={primaryClass}>
          {busy ? 'Sending...' : 'Email me a sign-in code'}
        </button>
        {error && <p role="alert" className="text-sm text-score-skip text-center">{error}</p>}
        <p className="text-xs text-gray-400 text-center">No password needed. We&apos;ll email you a code.</p>
        <div className="text-center">
          <button type="button" onClick={onBack} disabled={busy} className={linkClass}>
            Other ways to sign in
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => { e.preventDefault(); void verify(code); }}
    >
      <p className="text-sm text-gray-300 text-center">
        We sent a {EMAIL_CODE_LENGTH}-digit code to
        <span className="block font-semibold text-white [overflow-wrap:anywhere]">{email.trim()}</span>
      </p>
      <label htmlFor="signin-code" className="sr-only">Sign-in code</label>
      <input
        ref={codeRef}
        id="signin-code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        // Room for pasted "123 456": the browser cuts at maxLength before onChange cleans it.
        maxLength={EMAIL_CODE_LENGTH * 2}
        placeholder={'0'.repeat(EMAIL_CODE_LENGTH)}
        value={code}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, EMAIL_CODE_LENGTH);
          setCode(digits);
          // Pasted or autofilled codes sign in without another tap.
          if (digits.length === EMAIL_CODE_LENGTH) void verify(digits);
        }}
        disabled={busy || disabled}
        className={`${inputClass} text-center text-2xl tracking-[0.5em] font-mono`}
      />
      <button type="submit" disabled={busy || disabled || code.length !== EMAIL_CODE_LENGTH} className={primaryClass}>
        {busy ? 'Signing in...' : 'Sign in'}
      </button>
      {error && <p role="alert" className="text-sm text-score-skip text-center">{error}</p>}
      {notice && !error && <p role="status" className="text-sm text-gray-300 text-center">{notice}</p>}
      <p className="text-xs text-gray-400 text-center">Can&apos;t find it? Check your spam folder.</p>
      <div className="flex items-center justify-center gap-4">
        <button type="button" onClick={() => void send(true)} disabled={busy} className={linkClass}>
          Send a new code
        </button>
        <button
          type="button"
          onClick={() => { setStep('email'); setError(null); setNotice(null); }}
          disabled={busy}
          className={linkClass}
        >
          Use a different email
        </button>
      </div>
    </form>
  );
}
