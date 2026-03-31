'use client';

/**
 * EmailCaptureModal - Modal for capturing user emails before premium actions
 * Phase 0: Monetization optionality
 */

import { useState, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { track } from '@vercel/analytics';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import { SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';
import { isLondonPath } from '@/hooks/useCurrentMarket';

const FORMSPREE_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID || '';

export type GateTrigger =
  | 'csv_download'
  | 'json_download'
  | 'page_view_limit'
  | 'exit_intent'
  | 'scroll_depth'
  | 'return_visitor'
  | 'recapture'; // Re-engagement of pre-fix modal submissions (Jan 29 – Mar 12, 2026)

interface EmailCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CapturedUserData) => void;
  trigger: GateTrigger;
  /** If true, modal cannot be dismissed — user must enter email */
  blocking?: boolean;
}

export interface CapturedUserData {
  email: string;
  name?: string;
  company?: string;
  role?: string;
  capturedAt: string;
  trigger: GateTrigger;
}

const ROLE_OPTIONS = [
  { value: '', label: 'Select your role (optional)' },
  { value: 'investor', label: 'Investor / Producer' },
  { value: 'industry', label: 'Industry Professional' },
  { value: 'press', label: 'Press / Journalist' },
  { value: 'academic', label: 'Academic / Researcher' },
  { value: 'fan', label: 'Theater Fan' },
  { value: 'other', label: 'Other' },
];

function getTriggerCopy(trigger: GateTrigger, isWE: boolean): { heading: string; subheading: string } {
  const market = isWE ? 'West End' : 'Broadway';
  const copies: Record<GateTrigger, { heading: string; subheading: string }> = {
    csv_download: {
      heading: 'CSV Export Coming Soon',
      subheading: 'Be first to access Pro features including data exports, alerts, and historical data.',
    },
    json_download: {
      heading: 'API Access Coming Soon',
      subheading: 'Get early access to our data API for integrations and analysis.',
    },
    page_view_limit: {
      heading: 'Want to see more?',
      subheading: `Enter your email for full access to ${market} investment data.`,
    },
    exit_intent: {
      heading: `Never Miss a New ${market} Show`,
      subheading: 'No spam, no schedule \u2014 just opening night scores. Unsubscribe anytime.',
    },
    scroll_depth: {
      heading: `Never Miss a New ${market} Show`,
      subheading: 'Get opening night scores delivered to your inbox. Unsubscribe anytime.',
    },
    return_visitor: {
      heading: `Never miss a new ${market} show`,
      subheading: isWE
        ? 'We\u2019ll email you when new West End shows get their reviews, plus what\u2019s closing soon.'
        : 'We\u2019ll email you the CriticScore when new shows open, plus what\u2019s closing soon.',
    },
    recapture: {
      heading: 'Confirm your email',
      subheading: 'We updated how we send opening night scores. Enter your email once more to stay on the list.',
    },
  };
  return copies[trigger];
}

export default function EmailCaptureModal({
  isOpen,
  onClose,
  onSubmit,
  trigger,
  blocking = false,
}: EmailCaptureModalProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pathname = usePathname();

  const isWE = pathname ? isLondonPath(pathname) : false;
  const formId = isWE ? FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID : FORMSPREE_SUBSCRIBER_FORM_ID;
  const marketKey = isWE ? 'west-end' : 'broadway';
  const copy = getTriggerCopy(trigger, isWE);

  // Only show extra fields (name, company, role) for biz-specific triggers
  const showExtraFields = trigger === 'csv_download' || trigger === 'json_download' || trigger === 'page_view_limit';

  // Don't autoFocus for passive triggers — keyboard pop mid-scroll is jarring on mobile
  const shouldAutoFocus = trigger !== 'scroll_depth' && trigger !== 'exit_intent' && trigger !== 'return_visitor';

  // Track modal shown
  useEffect(() => {
    if (isOpen) {
      track('gate_modal_shown', { trigger, is_return_visitor: trigger === 'return_visitor' });
    }
  }, [isOpen, trigger]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Basic email validation
    if (!email || !email.includes('@') || !email.includes('.')) {
      setError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);

    try {
      const userData: CapturedUserData = {
        email: email.toLowerCase().trim(),
        name: name.trim() || undefined,
        company: company.trim() || undefined,
        role: role || undefined,
        capturedAt: new Date().toISOString(),
        trigger,
      };

      // Submit to Formspree so the email is actually captured server-side
      if (formId) {
        const body: Record<string, string> = {
          email: userData.email,
          source: `modal-${trigger}`,
          market: marketKey,
          page: pathname || '/',
        };
        if (userData.name) body.firstName = userData.name;
        const res = await fetch(`https://formspree.io/f/${formId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError('Something went wrong. Please try again.');
          setIsSubmitting(false);
          return;
        }
        // Mark as subscribed so inline forms (header/footer) don't nag again
        try {
          localStorage.setItem(SUBSCRIBED_KEY_PREFIX + marketKey, 'true');
          window.dispatchEvent(new Event('bsc_subscribed'));
        } catch { /* noop */ }
      }

      // Track email capture
      track('email_captured', {
        has_name: !!userData.name,
        has_company: !!userData.company,
        role: userData.role || 'none',
        trigger,
        is_return_visitor: trigger === 'return_visitor',
      });

      onSubmit(userData);

      // Reset form
      setEmail('');
      setName('');
      setCompany('');
      setRole('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [email, name, company, role, trigger, formId, marketKey, pathname, onSubmit]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="md"
      closeOnBackdrop={!blocking}
      closeOnEscape={!blocking}
      ariaLabel="Email capture"
    >
      {!blocking && (
        <ModalCloseButton onClick={onClose} className="absolute top-4 right-4 z-10" />
      )}

        {/* Header */}
        <div className="px-6 pt-8 pb-4 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-brand/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 id="modal-title" className="text-2xl font-bold text-white mb-2">
            {copy.heading}
          </h2>
          <p className="text-gray-400">
            {copy.subheading}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 pb-6">
          <div className="space-y-4">
            {/* Email - Required */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">
                Email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@gmail.com"
                required
                className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
                autoFocus={shouldAutoFocus}
              />
            </div>

            {/* Name, Company, Role - Only for biz-specific triggers */}
            {showExtraFields && (
              <>
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-1">
                    Name <span className="text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Smith"
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
                  />
                </div>

                <div>
                  <label htmlFor="company" className="block text-sm font-medium text-gray-300 mb-1">
                    Company <span className="text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="text"
                    id="company"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Broadway Productions LLC"
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
                  />
                </div>

                <div>
                  <label htmlFor="role" className="block text-sm font-medium text-gray-300 mb-1">
                    Role <span className="text-gray-500">(optional)</span>
                  </label>
                  <select
                    id="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all appearance-none cursor-pointer"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '20px' }}
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-surface-raised">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>

          {/* Error message */}
          {error && (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-6 px-6 py-3 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 focus:ring-offset-surface-raised"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Submitting...
              </span>
            ) : (
              showExtraFields ? 'Get Early Access' : 'Subscribe'
            )}
          </button>

          {/* Privacy note */}
          <p className="mt-4 text-xs text-gray-500 text-center">
            We respect your privacy. No spam, unsubscribe anytime.
          </p>
        </form>
    </Modal>
  );
}
