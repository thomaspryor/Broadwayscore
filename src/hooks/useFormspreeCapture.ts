'use client';

import { useState, useCallback, useEffect } from 'react';
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';
import { isFormspreeSubscribed, SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';
const FORMSPREE_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_FOLLOW_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_FOLLOW_FORM_ID || '';
const FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID || '';

export type Market = 'broadway' | 'west-end';
export type FormspreeStatus = 'idle' | 'submitting' | 'success' | 'error' | 'already_subscribed';

interface FormspreeCaptureOptions {
  userGroup: string;
  source: string;
  showId?: string;
  showTitle?: string;
  market?: Market;  // Override auto-detection from pathname
}

interface FormspreeCaptureResult {
  status: FormspreeStatus;
  errorMessage: string;
  submit: (email: string, options?: { firstName?: string }) => Promise<boolean>;
  isSubscribed: boolean;
  market: Market;
}

export function useFormspreeCapture(options: FormspreeCaptureOptions): FormspreeCaptureResult {
  const [status, setStatus] = useState<FormspreeStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const marketId = useCurrentMarket();

  // Infer market from URL pathname (including show slugs), with optional override
  const market: Market = options.market || (marketId === 'west-end' || marketId === 'off-west-end' ? 'west-end' : 'broadway');

  useEffect(() => {
    setIsSubscribed(isFormspreeSubscribed(market));
  }, [market]);

  const submit = useCallback(async (email: string, extra?: { firstName?: string }): Promise<boolean> => {
    if (!email || !email.includes('@') || !email.includes('.')) {
      setStatus('error');
      setErrorMessage('Please enter a valid email address.');
      return false;
    }

    setStatus('submitting');
    setErrorMessage('');

    // Subscribers → dedicated subscriber form; show follows → follow form
    // West End subscribers go to a separate form (with Broadway fallback)
    const isSubscriber = options.userGroup === 'main-site-subscriber';
    let formId: string;
    if (!isSubscriber) {
      formId = FORMSPREE_FOLLOW_FORM_ID;
    } else if (market === 'west-end' && FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID) {
      formId = FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID;
    } else {
      formId = FORMSPREE_SUBSCRIBER_FORM_ID;
    }

    if (!formId) {
      console.error(`useFormspreeCapture: Formspree ${isSubscriber ? 'subscriber' : 'follow'} form ID not configured.`);
      setStatus('error');
      setErrorMessage('Email subscription is not available right now.');
      return false;
    }

    try {
      const body: Record<string, string> = {
        email: email.toLowerCase().trim(),
        source: options.source,
        market,
        page: typeof window !== 'undefined' ? window.location.pathname : '/',
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
          localStorage.setItem(SUBSCRIBED_KEY_PREFIX + market, 'true');
          window.dispatchEvent(new Event('bsc_subscribed'));
        } catch { /* noop */ }
        setIsSubscribed(true);
        track('email_captured', { source: options.source, userGroup: options.userGroup, market });
        captureEvent('email_captured', { source: options.source, userGroup: options.userGroup, market });
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
  }, [options.source, options.userGroup, options.showId, options.showTitle, market]);

  return { status, errorMessage, submit, isSubscribed, market };
}
