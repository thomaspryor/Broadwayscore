'use client';

import { useState, useCallback, useEffect } from 'react';
import { track } from '@vercel/analytics';

const SUBSCRIBED_KEY = 'bsc_email_subscribed';
const FORM_ID = process.env.NEXT_PUBLIC_LOOPS_FORM_ID || '';

export type LoopsStatus = 'idle' | 'submitting' | 'success' | 'error' | 'already_subscribed';

interface LoopsCaptureOptions {
  userGroup: string;
  source: string;
  showId?: string;
  showTitle?: string;
}

interface LoopsCaptureResult {
  status: LoopsStatus;
  errorMessage: string;
  submit: (email: string, options?: { firstName?: string }) => Promise<boolean>;
  isSubscribed: boolean;
}

export function useLoopsCapture(options: LoopsCaptureOptions): LoopsCaptureResult {
  const [status, setStatus] = useState<LoopsStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubscribed, setIsSubscribed] = useState(false);

  useEffect(() => {
    try {
      setIsSubscribed(localStorage.getItem(SUBSCRIBED_KEY) === 'true');
    } catch {
      // localStorage not available
    }
  }, []);

  const submit = useCallback(async (email: string, extra?: { firstName?: string }): Promise<boolean> => {
    if (!email || !email.includes('@') || !email.includes('.')) {
      setStatus('error');
      setErrorMessage('Please enter a valid email address.');
      return false;
    }

    setStatus('submitting');
    setErrorMessage('');

    // If no Form ID configured, still save locally
    if (!FORM_ID) {
      try {
        localStorage.setItem(SUBSCRIBED_KEY, 'true');
      } catch { /* noop */ }
      setIsSubscribed(true);
      setStatus('success');
      track('email_captured', { source: options.source, userGroup: options.userGroup });
      return true;
    }

    try {
      const body = new URLSearchParams();
      body.append('email', email.toLowerCase().trim());
      if (extra?.firstName) body.append('firstName', extra.firstName);
      body.append('userGroup', options.userGroup);
      // Custom properties
      if (options.source) body.append('source', options.source);
      if (options.showId) body.append('showId', options.showId);
      if (options.showTitle) body.append('showTitle', options.showTitle);

      const res = await fetch(`https://app.loops.so/api/newsletter-form/${FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.message === 'Email already on list') {
          setStatus('already_subscribed');
        } else {
          setStatus('success');
        }
        try {
          localStorage.setItem(SUBSCRIBED_KEY, 'true');
        } catch { /* noop */ }
        setIsSubscribed(true);
        track('email_captured', { source: options.source, userGroup: options.userGroup });
        return true;
      } else {
        setStatus('error');
        setErrorMessage('Something went wrong. Please try again.');
        return false;
      }
    } catch {
      setStatus('error');
      setErrorMessage('Network error. Please try again.');
      return false;
    }
  }, [options.source, options.userGroup, options.showId, options.showTitle]);

  return { status, errorMessage, submit, isSubscribed };
}
