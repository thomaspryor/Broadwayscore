'use client';

import { useState, useCallback, useEffect } from 'react';
import { track } from '@vercel/analytics';

const SUBSCRIBED_KEY = 'bsc_email_subscribed';
const FORMSPREE_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_FOLLOW_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_FOLLOW_FORM_ID || '';

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

    // Subscribers → dedicated subscriber form; show follows → follow form
    const isSubscriber = options.userGroup === 'main-site-subscriber';
    const formId = isSubscriber ? FORMSPREE_SUBSCRIBER_FORM_ID : FORMSPREE_FOLLOW_FORM_ID;

    if (!formId) {
      console.error(`useLoopsCapture: Formspree ${isSubscriber ? 'subscriber' : 'follow'} form ID not configured.`);
      setStatus('error');
      setErrorMessage('Email subscription is not available right now.');
      return false;
    }

    try {
      const body: Record<string, string> = {
        email: email.toLowerCase().trim(),
        source: options.source,
      };
      if (extra?.firstName) body.firstName = extra.firstName;
      if (!isSubscriber && options.showId) {
        body.showId = options.showId;
        if (options.showTitle) body.showTitle = options.showTitle;
      }

      const res = await fetch(`https://formspree.io/f/${formId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setStatus('success');
        try {
          localStorage.setItem(SUBSCRIBED_KEY, 'true');
          window.dispatchEvent(new Event('bsc_subscribed'));
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
